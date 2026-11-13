import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { encodeBase64Url } from '@altis/crypto';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type SettingsScope, type TableName } from '@altis/db';
import { resetTestFaults, uploadPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { gcBlobs } from '../../src/backup/blobs.js';
import { backupTables, tableChecksumFromDb } from '../../src/backup/canonical.js';
import { listBackups } from '../../src/backup/catalog.js';
import {
  EXPORT_BATCH,
  PART_MAX_ROWS,
  createExporter,
  type ExportCheckpoint,
  type ExporterOptions,
} from '../../src/backup/exporter.js';
import { readManifest, verifyManifestHmac, type BackupManifest } from '../../src/backup/manifest.js';

// The resumable backup exporter (spec §9.9, P7, P9; decisions C12, C13; preflight S13, S14) on the engine picked by
// ALTIS_TEST_DB: every data, config and history table in parts of at most 50 000 rows in primary-key order, each part
// gzip-written atomically and recorded in the checkpoint after its rename; per-table checksums from the written parts
// with the secret columns left out; content-addressed upload blobs; the manifest written last with the installation's
// HMAC. A step stops at its deadline (a part closes 2 s before it) and a new exporter, even in another process, goes
// on from the checkpoint.

// Lets a test fail chosen file removals the way Windows does while another program (an antivirus scanner, a backup
// agent) holds the file open: EBUSY, for longer than the helper's retries last.
const hooks = vi.hoisted(() => ({ failRemove: null as ((p: string) => boolean) | null }));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  const removeFile: typeof actual.removeFile = async (p) => {
    if (hooks.failRemove?.(p) === true) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${p}'`), { code: 'EBUSY' });
    await actual.removeFile(p);
  };
  return { ...actual, removeFile };
});

const ctx = testDbContext();
const NOW = 1_800_000_000_000;
const KEY = new Uint8Array(32).fill(11);
const OTHER_KEY = new Uint8Array(32).fill(12);
const INSTALL_ID = newId(NOW);
const SCHEMA_VERSION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
const AUDIT_ROWS = 120_001;
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const FILE_CONTENT = Buffer.from('the same bytes in two uploads\n');
const FILE_IDS = [newId(NOW + 20), newId(NOW + 21), newId(NOW + 22)];

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Audit row ids that sort like their number (byte order = numeric order). */
const auditId = (i: number): string => `A${String(i).padStart(25, '0')}`;

/** A table's summary without its part boundaries, which depend on the deadlines the export ran with. */
function summary(m: BackupManifest): Record<string, { class: string; columns: string[]; rows: number; checksum: string }> {
  const out: Record<string, { class: string; columns: string[]; rows: number; checksum: string }> = {};
  for (const [table, t] of Object.entries(m.tables)) out[table] = { class: t.class, columns: t.columns, rows: t.rows, checksum: t.checksum };
  return out;
}

describe.skipIf(!ctx.available)(`backup export [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let scratch: string;
  let oneShot: BackupManifest;

  function options(over: Partial<ExporterOptions> = {}): ExporterOptions {
    return {
      read: h.db,
      dialect: h.dialect,
      dataDir,
      backupId: newId(),
      kind: 'manual',
      includeFiles: false,
      consistency: 'frozen',
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      installId: INSTALL_ID,
      sessionKey: KEY,
      kids: ['k1'],
      auditHead: { seq: AUDIT_ROWS, hash: 'f'.repeat(64) },
      clock: () => Date.now(),
      ...over,
    };
  }

  /** Runs a whole export with long deadlines and returns its manifest. */
  async function exportAll(over: Partial<ExporterOptions> = {}): Promise<BackupManifest> {
    const o = options(over);
    const exporter = createExporter(o);
    let checkpoint: ExportCheckpoint | null = null;
    for (let i = 0; i < 1000; i += 1) {
      const r = await exporter.step(checkpoint, { deadline: Date.now() + 60_000 });
      checkpoint = r.checkpoint;
      if (r.done) {
        expect(r.progress).toBe(100);
        const m = await readManifest(dataDir, o.backupId);
        expect(m).not.toBeNull();
        // The part log goes once the manifest is written.
        await expect(fsp.stat(partLogFile(o.backupId))).rejects.toMatchObject({ code: 'ENOENT' });
        return m!;
      }
    }
    throw new Error('the export did not finish');
  }

  function partFile(backupId: string, table: string, n: number): string {
    return path.join(dataDir, 'backups', backupId, 'tables', table, `${String(n).padStart(5, '0')}.jsonl.gz`);
  }

  function partLogFile(backupId: string): string {
    return path.join(dataDir, 'backups', backupId, 'parts.jsonl');
  }

  /** Checks every part file of `m` against its manifest entry: SHA-256, uncompressed bytes, rows, first/last key. */
  async function checkParts(m: BackupManifest): Promise<void> {
    for (const [table, t] of Object.entries(m.tables)) {
      expect(t.parts.map((p) => p.n)).toEqual(t.parts.map((_, i) => i + 1));
      expect(t.parts.reduce((sum, p) => sum + p.rows, 0)).toBe(t.rows);
      for (const p of t.parts) {
        const file = await fsp.readFile(partFile(m.backupId, table, p.n));
        expect(sha(file)).toBe(p.sha256);
        const plain = gunzipSync(file);
        expect(plain.byteLength).toBe(p.bytes);
        const lines = plain.toString('utf8').split('\n');
        expect(lines.pop()).toBe('');
        expect(lines.length).toBe(p.rows);
        if (p.rows === 0) {
          expect(p.firstPk).toBeNull();
          expect(p.lastPk).toBeNull();
        } else {
          expect(p.rows).toBeLessThanOrEqual(PART_MAX_ROWS);
          const first = JSON.parse(lines[0]!) as Record<string, unknown>;
          expect(Object.keys(first)).toEqual([...t.columns].sort());
        }
      }
      // No part beyond the last one listed.
      await expect(fsp.stat(partFile(m.backupId, table, t.parts.length + 1))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-export-'));
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-export-cp-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: h.dataDir, migrations: PHASE1_MIGRATIONS });

    await withTx(h, async (trx) => {
      for (const [i, code] of ['pusat', 'timur', 'barat'].entries()) {
        await trx
          .insertInto('branches')
          .values({
            id: newId(NOW + i),
            code_key: code,
            code_display: code.toUpperCase(),
            name: `Cabang ${code}`,
            timezone: 'Asia/Jakarta',
            is_default: i === 0 ? 1 : 0,
            created_at: NOW,
            updated_at: NOW,
          })
          .execute();
      }
      for (const [i, name] of ['ani', 'budi'].entries()) {
        await trx
          .insertInto('staff_users')
          .values({
            id: newId(NOW + 10 + i),
            username_key: name,
            username_display: name,
            name: `Staf ${name}`,
            password_hash: 'x',
            status: 'active',
            totp_secret_enc: i === 0 ? 'v1:k1:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbb' : null,
            totp_enabled: i === 0 ? 1 : 0,
            created_at: NOW,
            updated_at: NOW,
          })
          .execute();
      }
      const settings: [string, string | null, number, SettingsScope][] = [
        ['library.name', '"Perpustakaan Arsya"', 0, 'data'],
        ['library.timezone', '"Asia/Jakarta"', 0, 'data'],
        ['library.locale', '"id"', 0, 'data'],
        ['smtp.host', '"mail.example.test"', 0, 'data'],
        ['smtp.password', 'v1:k1:cccccccccccccccc:dddddddddddddddddddddddd', 1, 'data'],
        ['system.ip_trust', '"ok"', 0, 'instance'],
      ];
      for (const [key, value, isSecret, scope] of settings) {
        await trx.insertInto('settings').values({ key, value, is_secret: isSecret, scope, updated_at: NOW }).execute();
      }
      // Two uploads with the same content and one whose file is gone.
      for (const [i, status] of ['ok', 'ok', 'missing'].entries()) {
        await trx
          .insertInto('files')
          .values({
            id: FILE_IDS[i]!,
            original_name: `f${i}.txt`,
            mime: 'text/plain',
            size: FILE_CONTENT.byteLength,
            sha256: sha(FILE_CONTENT),
            context: 'test',
            access: 'staff',
            status,
            created_at: NOW,
          })
          .execute();
      }
    });
    for (let i = 0; i < 2; i += 1) {
      const file = uploadPath(dataDir, FILE_IDS[i]!);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, FILE_CONTENT);
    }

    const BATCH = 1000;
    await withTx(h, async (trx) => {
      for (let start = 0; start < AUDIT_ROWS; start += BATCH) {
        const rows = [];
        for (let i = start; i < Math.min(start + BATCH, AUDIT_ROWS); i += 1) {
          rows.push({
            id: auditId(i),
            seq: i + 1,
            at: NOW + i,
            actor_type: 'system',
            action: 'settings.update',
            meta: `{"n":${i}}`,
            prev_hash: '0'.repeat(64),
            hash: '1'.repeat(64),
          });
        }
        await trx.insertInto('audit_log').values(rows).execute();
      }
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
    if (scratch !== undefined) await fsp.rm(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    hooks.failRemove = null;
  });

  it('exports every backup table in parts of at most 50 000 rows, leaving out the instance settings', async () => {
    oneShot = await exportAll();
    const tables = backupTables(SCHEMA_VERSION);
    expect(Object.keys(oneShot.tables)).toEqual(tables.map((t) => t.table));
    for (const absent of ['sessions', 'jobs', 'events', 'locks', 'upload_sessions', 'license_state', 'audit_head', 'schema_meta']) {
      expect(oneShot.tables).not.toHaveProperty(absent);
    }
    const audit = oneShot.tables['audit_log']!;
    expect(audit.rows).toBe(AUDIT_ROWS);
    expect(audit.parts.map((p) => p.rows)).toEqual([50_000, 50_000, 20_001]);
    expect(audit.parts[0]!.firstPk).toEqual([auditId(0)]);
    expect(audit.parts[0]!.lastPk).toEqual([auditId(49_999)]);
    expect(audit.parts[2]!.lastPk).toEqual([auditId(AUDIT_ROWS - 1)]);
    expect(oneShot.tables['settings']!.rows).toBe(5);
    expect(oneShot.tables['branches']!.rows).toBe(3);
    expect(oneShot.tables['staff_users']!.rows).toBe(2);
    // An empty table has one empty part.
    expect(oneShot.tables['roles']!.parts).toEqual([
      expect.objectContaining({ n: 1, rows: 0, firstPk: null, lastPk: null, bytes: 0 }),
    ]);
    await checkParts(oneShot);

    const settingsLines = gunzipSync(await fsp.readFile(partFile(oneShot.backupId, 'settings', 1)))
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { key: string });
    expect(settingsLines.map((r) => r.key)).toEqual(['library.locale', 'library.name', 'library.timezone', 'smtp.host', 'smtp.password']);

    expect(oneShot).toMatchObject({
      format: 'altis-backup/1',
      kind: 'manual',
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      dialect: h.dialect,
      consistency: 'frozen',
      kids: ['k1'],
      installId: INSTALL_ID,
      auditHead: { seq: AUDIT_ROWS, hash: 'f'.repeat(64) },
      includesFiles: false,
      secrets: 'keyring',
      blobs: [],
    });
    // Every manifest checksum is the database's.
    for (const { table } of tables) {
      expect(oneShot.tables[table]!.checksum, table).toBe(await tableChecksumFromDb(h.db, h.dialect, table as TableName));
    }
  }, 120_000);

  it("ignores smtp.password's sealed value in the settings checksum, but follows library.name", async () => {
    const before = oneShot.tables['settings']!.checksum;
    await h.db.updateTable('settings').set({ value: 'v1:k2:eeeeeeeeeeeeeeee:ffffffffffffffffffffffff' }).where('key', '=', 'smtp.password').execute();
    await h.db.updateTable('staff_users').set({ totp_secret_enc: 'v1:k2:gggggggggggggggg:hhhhhhhhhhhhhhhhhhhhhhhh' }).where('username_key', '=', 'ani').execute();
    try {
      const resealed = await exportAll();
      expect(resealed.tables['settings']!.checksum).toBe(before);
      expect(resealed.tables['staff_users']!.checksum).toBe(oneShot.tables['staff_users']!.checksum);
      // The parts themselves did change: the sealed values are in them.
      expect(resealed.tables['settings']!.parts[0]!.sha256).not.toBe(oneShot.tables['settings']!.parts[0]!.sha256);

      await h.db.updateTable('settings').set({ value: '"Perpustakaan Baru"' }).where('key', '=', 'library.name').execute();
      expect(await tableChecksumFromDb(h.db, h.dialect, 'settings')).not.toBe(before);
      const renamed = await exportAll();
      expect(renamed.tables['settings']!.checksum).not.toBe(before);
      expect(renamed.tables['settings']!.checksum).toBe(await tableChecksumFromDb(h.db, h.dialect, 'settings'));
    } finally {
      await h.db.updateTable('settings').set({ value: 'v1:k1:cccccccccccccccc:dddddddddddddddddddddddd' }).where('key', '=', 'smtp.password').execute();
      await h.db.updateTable('settings').set({ value: '"Perpustakaan Arsya"' }).where('key', '=', 'library.name').execute();
      await h.db.updateTable('staff_users').set({ totp_secret_enc: 'v1:k1:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbb' }).where('username_key', '=', 'ani').execute();
    }
    expect(await tableChecksumFromDb(h.db, h.dialect, 'settings')).toBe(before);
  }, 120_000);

  it('stops at a near deadline inside audit_log, and a new exporter finishes from that checkpoint', async () => {
    const o = options();
    const auditIndex = backupTables(SCHEMA_VERSION).findIndex((t) => t.table === 'audit_log');
    // A step always does one unit of work: the tables before audit_log in load order (Phase 2: `agents`, empty here)
    // take a near-deadline step each, then audit_log's first part does.
    let first = await createExporter(o).step(null, { deadline: Date.now() + 50 });
    const beforeAuditPart2 = (c: ExportCheckpoint) => c.table < auditIndex || (c.table === auditIndex && c.part === 1);
    for (let i = 0; i < auditIndex && !first.done && beforeAuditPart2(first.checkpoint); i += 1) {
      first = await createExporter(o).step(first.checkpoint, { deadline: Date.now() + 50 });
    }
    expect(first.done).toBe(false);
    // The checkpoint is JSON: it crosses slices, processes and job payloads.
    const checkpoint = JSON.parse(JSON.stringify(first.checkpoint)) as ExportCheckpoint;
    expect(checkpoint).toMatchObject({ phase: 'tables', table: auditIndex, part: 2, after: [auditId(EXPORT_BATCH - 1)] });
    expect(checkpoint.written['audit_log']).toBe(1);
    expect(first.progress).toBeGreaterThanOrEqual(0);
    expect(first.progress).toBeLessThan(100);
    // The part's record is the last line of the part log, whose length the checkpoint holds.
    const log = await fsp.readFile(partLogFile(o.backupId));
    expect(log.byteLength).toBe(checkpoint.log);
    const records = log.toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({ table: 'audit_log', n: 1, rows: EXPORT_BATCH, firstPk: [auditId(0)] });
    // A part log that lost bytes the checkpoint vouches for cannot be resumed.
    await fsp.truncate(partLogFile(o.backupId), checkpoint.log - 1);
    const short = await createExporter(o)
      .step(checkpoint, { deadline: Date.now() + 60_000 })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isDomainError(short) ? { code: short.code, meta: short.meta } : short).toEqual({ code: 'BACKUP_INVALID', meta: { reason: 'checksum' } });
    await fsp.writeFile(partLogFile(o.backupId), log);

    const second = createExporter(o);
    let cp: ExportCheckpoint = checkpoint;
    for (;;) {
      const r = await second.step(cp, { deadline: Date.now() + 60_000 });
      cp = r.checkpoint;
      if (r.done) break;
    }
    const resumed = (await readManifest(dataDir, o.backupId))!;
    expect(summary(resumed)).toEqual(summary(oneShot));
    expect(resumed.tables['audit_log']!.parts[0]!.rows).toBe(EXPORT_BATCH);
    await checkParts(resumed);
  }, 120_000);

  it('goes the whole way in steps with 50 ms deadlines: each part, each part checksum and the manifest resume', async () => {
    const o = options();

    /** A part changed after it was written is caught when the checksums are computed from it. */
    async function damagedPartCaught(atChecksums: ExportCheckpoint): Promise<void> {
      const victim = partFile(o.backupId, 'branches', 1);
      const original = await fsp.readFile(victim);
      const bytes = Buffer.from(original);
      bytes[bytes.byteLength - 9] = (bytes[bytes.byteLength - 9]! + 1) % 256;
      await fsp.writeFile(victim, bytes);
      let caught: unknown = null;
      try {
        let cp: ExportCheckpoint = atChecksums;
        for (;;) {
          const r = await createExporter(o).step(cp, { deadline: Date.now() + 60_000 });
          cp = r.checkpoint;
          if (r.done) break;
        }
      } catch (error) {
        caught = error;
      } finally {
        await fsp.writeFile(victim, original);
      }
      expect(isDomainError(caught) ? { code: caught.code, meta: caught.meta } : caught).toMatchObject({
        code: 'BACKUP_INVALID',
        meta: { reason: 'checksum', table: 'branches', part: 1 },
      });
    }

    let checkpoint: ExportCheckpoint | null = null;
    let damageChecked = false;
    let atManifest: ExportCheckpoint | null = null;
    let midstates = 0;
    let steps = 0;
    for (;;) {
      // A new exporter for every step, as a new process or slice would make, and the checkpoint through JSON.
      const r = await createExporter(o).step(checkpoint, { deadline: Date.now() + 50 });
      steps += 1;
      checkpoint = JSON.parse(JSON.stringify(r.checkpoint)) as ExportCheckpoint;
      if (checkpoint.phase === 'checksums' && !damageChecked) {
        // At the first checksum step, before branches is hashed: damage its part, see it caught, repair it, go on.
        damageChecked = true;
        await damagedPartCaught(checkpoint);
      }
      if (checkpoint.phase === 'checksums' && typeof checkpoint.hash === 'string') midstates += 1;
      if (checkpoint.phase === 'manifest') atManifest ??= checkpoint;
      if (r.done) break;
      expect(steps).toBeLessThan(2000);
    }
    expect(damageChecked).toBe(true);
    // audit_log alone: 121 parts of at most 1000 rows, each hashed in a step of its own.
    expect(midstates).toBeGreaterThanOrEqual(120);
    const m = (await readManifest(dataDir, o.backupId))!;
    expect(summary(m)).toEqual(summary(oneShot));
    expect(m.tables['audit_log']!.parts).toHaveLength(Math.ceil(AUDIT_ROWS / EXPORT_BATCH));
    await checkParts(m);

    // A step that died after writing the manifest and removing the part log, run again, finds the manifest in place.
    expect(atManifest).not.toBeNull();
    await expect(fsp.stat(partLogFile(o.backupId))).rejects.toMatchObject({ code: 'ENOENT' });
    const again = await createExporter(o).step(atManifest, { deadline: Date.now() + 60_000 });
    expect(again).toMatchObject({ done: true, progress: 100, checkpoint: { phase: 'done' } });
    expect(await readManifest(dataDir, o.backupId)).toEqual(m);
  }, 180_000);

  it('finishes a backup whose part log cannot be removed after the manifest is written (a file held open on Windows)', async () => {
    const o = options();
    // An antivirus scanner holds this backup's parts.jsonl open: every removal of it fails, the retries included.
    const tries: string[] = [];
    hooks.failRemove = (p) => {
      if (path.basename(p) !== 'parts.jsonl' || !p.includes(o.backupId)) return false;
      tries.push(p);
      return true;
    };
    const r = await createExporter(o).step(null, { deadline: Date.now() + 60_000 });
    // The backup is complete once its manifest is in place: the log that stays goes with the backup's folder.
    expect(tries).toHaveLength(1);
    expect(r).toMatchObject({ done: true, progress: 100, checkpoint: { phase: 'done' } });
    const m = (await readManifest(dataDir, o.backupId))!;
    expect(verifyManifestHmac(KEY, m)).toBe(true);
    expect(summary(m)).toEqual(summary(oneShot));
    await checkParts(m);
    expect((await fsp.stat(partLogFile(o.backupId))).size).toBe(r.checkpoint.log);

    // A step run again from the manifest checkpoint, with the log still there, writes the same manifest and is done.
    const again = await createExporter(o).step({ ...r.checkpoint, phase: 'manifest' }, { deadline: Date.now() + 60_000 });
    expect(again).toMatchObject({ done: true, progress: 100, checkpoint: { phase: 'done' } });
    expect(tries).toHaveLength(2);
    expect(await readManifest(dataDir, o.backupId)).toEqual(m);
  }, 120_000);

  // The checkpoint is a job's payload (Task 20): jobs.payload holds at most 65 535 bytes on MySQL/MariaDB (TEXT), so
  // the checkpoint must not grow with the number of parts. Its content is canonical JSON whatever the engine (keys,
  // counts, checksums), so one engine shows the bound; 2 000 parts take about 25 s, mostly fsyncs.
  it.skipIf(ctx.engine !== 'sqlite')('keeps the checkpoint under 16 KiB at every step of a 2 000-part export', async () => {
    const PART_ROWS = 60;
    const CAP = 16 * 1024;
    const o = options();
    let steps = 0;
    process.env['ALTIS_TEST_EXPORT_PART_ROWS'] = String(PART_ROWS);
    try {
      let checkpoint: ExportCheckpoint | null = null;
      for (;;) {
        // Steps of about 300 ms of work (a part closes, and a step ends, 2 s before the deadline), each in a new
        // exporter with the checkpoint through JSON, as separate slices would run them.
        const r = await createExporter(o).step(checkpoint, { deadline: Date.now() + 2300 });
        const json = JSON.stringify(r.checkpoint);
        steps += 1;
        expect(Buffer.byteLength(json, 'utf8'), `step ${steps} (${r.checkpoint.phase})`).toBeLessThan(CAP);
        checkpoint = JSON.parse(json) as ExportCheckpoint;
        if (r.done) break;
        expect(steps).toBeLessThan(5000);
      }
    } finally {
      delete process.env['ALTIS_TEST_EXPORT_PART_ROWS'];
    }
    const m = (await readManifest(dataDir, o.backupId))!;
    const audit = m.tables['audit_log']!;
    expect(audit.parts).toHaveLength(Math.ceil(AUDIT_ROWS / PART_ROWS));
    expect(audit.parts.length).toBeGreaterThanOrEqual(2000);
    expect(audit.parts.every((p) => p.rows <= PART_ROWS)).toBe(true);
    expect(summary(m)).toEqual(summary(oneShot));
    await checkParts(m);
  }, 180_000);

  it('a full disk while writing a part leaves no trace of that part and keeps the parts before it (P21)', async () => {
    const o = options();
    resetTestFaults();
    // The write of audit_log's second part under backups/ throws a synthetic EDQUOT. With a 60 s deadline the writes
    // follow the load order: each table before audit_log (empty here) writes its one part, the part log counts once
    // (when the first part's record creates it), then audit_log writes its 3 parts, so the fault lands on one of its
    // parts after the first.
    const auditIndex = backupTables(SCHEMA_VERSION).findIndex((t) => t.table === 'audit_log');
    process.env['ALTIS_TEST_FAULT'] = `disk-full:backups:${auditIndex + 3}`;
    let caught: unknown = null;
    try {
      await createExporter(o).step(null, { deadline: Date.now() + 60_000 });
    } catch (error) {
      caught = error;
    } finally {
      delete process.env['ALTIS_TEST_FAULT'];
      resetTestFaults();
    }
    expect(isDomainError(caught) && caught.code).toBe('DISK_QUOTA');
    // The part that received the EDQUOT: DISK_QUOTA names the file it was writing.
    const hit = /tables[\\/]([a-z][a-z0-9_]*)[\\/](\d{5})\.jsonl\.gz/.exec((caught as Error).message);
    expect(hit, (caught as Error).message).not.toBeNull();
    const table = hit![1]!;
    const n = Number(hit![2]);
    expect(n).toBeGreaterThan(1);
    // Its folder holds exactly the parts before it: neither the part nor its hidden temporary file is left.
    const left = (await fsp.readdir(path.join(dataDir, 'backups', o.backupId, 'tables', table))).sort();
    expect(left).toEqual(Array.from({ length: n - 1 }, (_, i) => `${String(i + 1).padStart(5, '0')}.jsonl.gz`));
  }, 120_000);

  // SQLite alone stores a fraction in an INTEGER column (type affinity): a row that cannot be written canonically.
  it.skipIf(ctx.engine !== 'sqlite')('a row failing in the middle of a part leaves neither the part nor its temporary file', async () => {
    const o = options();
    await h.db.updateTable('audit_log').set({ at: 1.5 }).where('id', '=', auditId(5500)).execute();
    let caught: unknown = null;
    try {
      await createExporter(o).step(null, { deadline: Date.now() + 60_000 });
    } catch (error) {
      caught = error;
    } finally {
      await h.db.updateTable('audit_log').set({ at: NOW + 5500 }).where('id', '=', auditId(5500)).execute();
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(String(caught)).toContain('audit_log.at');
    const left = await fsp.readdir(path.join(dataDir, 'backups', o.backupId, 'tables', 'audit_log')).catch(() => []);
    expect(left).toEqual([]);
  }, 120_000);

  it('a process killed after a part was written is followed by one that resumes without losing or doubling a part', async () => {
    const backupId = newId();
    const checkpointFile = path.join(scratch, `${backupId}.json`);
    const child = (stepMs: number, fault: string | null) =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env['ALTIS_TEST_FAULT'];
        if (fault !== null) env['ALTIS_TEST_FAULT'] = fault;
        const p = fork(
          path.join(import.meta.dirname, '../fixtures/export-child.mjs'),
          [
            JSON.stringify({
              config: h.config,
              dbDataDir: h.dataDir,
              dataDir,
              backupId,
              checkpointFile,
              stepMs,
              sessionKey: encodeBase64Url(KEY),
              schemaVersion: SCHEMA_VERSION,
              installId: INSTALL_ID,
              includeFiles: false,
              auditHead: { seq: AUDIT_ROWS, hash: 'f'.repeat(64) },
            }),
          ],
          { cwd: ROOT, env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
        );
        const timer = setTimeout(() => p.kill('SIGKILL'), 90_000);
        p.on('error', reject);
        p.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });

    const killed = await child(50, 'export-mid-part:2');
    expect(killed.signal).toBe('SIGKILL');
    const stored = JSON.parse(await fsp.readFile(checkpointFile, 'utf8')) as ExportCheckpoint;
    expect(stored).toMatchObject({ phase: 'tables', part: 2 });
    expect(stored.written['audit_log']).toBe(1);
    // Part 2 was written to its temporary file only: it was never renamed into place.
    await expect(fsp.stat(partFile(backupId, 'audit_log', 2))).rejects.toMatchObject({ code: 'ENOENT' });

    const resumed = await child(15_000, null);
    expect(resumed).toEqual({ code: 0, signal: null });
    const m = (await readManifest(dataDir, backupId))!;
    expect(summary(m)).toEqual(summary(oneShot));
    expect(m.tables['audit_log']!.rows).toBe(AUDIT_ROWS);
    await checkParts(m);
  }, 180_000);

  it('links uploads as content-addressed blobs once, and gcBlobs removes a blob no manifest refers to', async () => {
    const m = await exportAll({ includeFiles: true });
    expect(m.includesFiles).toBe(true);
    expect(m.blobs).toEqual([{ sha256: sha(FILE_CONTENT), size: FILE_CONTENT.byteLength }]);
    const blob = path.join(dataDir, 'backups', 'blobs', sha(FILE_CONTENT));
    expect(await fsp.readFile(blob)).toEqual(FILE_CONTENT);
    expect(await fsp.readdir(path.join(dataDir, 'backups', 'blobs'))).toEqual([sha(FILE_CONTENT)]);

    // A blob nobody refers to, besides the one this backup refers to.
    const stray = randomBytes(16);
    await fsp.writeFile(path.join(dataDir, 'backups', 'blobs', sha(stray)), stray);
    // gcBlobs reads the kept backups' manifests (1d: referencedBlobs, one rule for every collector).
    expect(await gcBlobs(dataDir, [{ id: m.backupId }, { id: oneShot.backupId }])).toBe(1);
    expect(await fsp.readFile(blob)).toEqual(FILE_CONTENT);

    await fsp.rm(path.join(dataDir, 'backups', m.backupId), { recursive: true });
    expect(await gcBlobs(dataDir, [{ id: oneShot.backupId }])).toBe(1);
    await expect(fsp.stat(blob)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await gcBlobs(dataDir, [{ id: oneShot.backupId }])).toBe(0);
  }, 120_000);

  it("verifies the manifest's HMAC with the installation's session key only, and not after any change", () => {
    expect(verifyManifestHmac(KEY, oneShot)).toBe(true);
    expect(verifyManifestHmac(OTHER_KEY, oneShot)).toBe(false);
    const changes: ((m: BackupManifest) => void)[] = [
      (m) => (m.createdAt += 1),
      (m) => (m.kind = 'scheduled'),
      (m) => (m.installId = newId()),
      (m) => (m.includesFiles = true),
      (m) => m.kids.push('k2'),
      (m) => (m.auditHead.seq += 1),
      (m) => (m.tables['branches']!.checksum = '0'.repeat(64)),
      (m) => (m.tables['audit_log']!.parts[1]!.rows -= 1),
      (m) => m.blobs.push({ sha256: '0'.repeat(64), size: 1 }),
    ];
    for (const change of changes) {
      const copy = structuredClone(oneShot);
      change(copy);
      expect(verifyManifestHmac(KEY, copy)).toBe(false);
    }
  });

  it('lists the backups rows with what their manifests say', async () => {
    const running = newId();
    const uploaded = newId();
    const row = (id: string, kind: string, status: string, createdAt: number) => ({
      id,
      kind,
      size: status === 'ok' ? 1234 : null,
      sha256: null,
      schema_version: '0009',
      app_version: '0.1.0',
      dialect: h.dialect,
      consistency: 'frozen',
      status,
      created_at: createdAt,
    });
    await h.db
      .insertInto('backups')
      .values([
        row(oneShot.backupId, 'manual', 'ok', NOW),
        row(running, 'scheduled', 'running', NOW + 2),
        row(uploaded, 'external', 'uploaded', NOW + 1),
      ])
      .execute();
    const items = await listBackups(h.db, dataDir, KEY);
    expect(items.map((i) => i.id)).toEqual([running, uploaded, oneShot.backupId]);
    expect(items[2]).toEqual({
      id: oneShot.backupId,
      kind: 'manual',
      status: 'ok',
      size: 1234,
      createdAt: NOW,
      consistency: 'frozen',
      includesFiles: false,
      external: false,
      sameInstall: true,
      schemaVersion: '0009',
      appVersion: '0.1.0',
      dialect: h.dialect,
    });
    expect(items[0]).toMatchObject({ status: 'running', sameInstall: false, external: false, includesFiles: false });
    expect(items[1]).toMatchObject({ status: 'uploaded', sameInstall: false, external: true });
    const elsewhere = await listBackups(h.db, dataDir, OTHER_KEY);
    expect(elsewhere[2]).toMatchObject({ sameInstall: false });
  });
});
