import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { referencedBlobs } from '../../src/backup/blob-refs.js';
import { gcBlobs } from '../../src/backup/blobs.js';
import { writeManifest, type BackupManifest } from '../../src/backup/manifest.js';
import { collectBlobs } from '../../src/backup/retention.js';
import type { CoreLogger } from '../../src/context.js';
import { cleanFiles } from '../../src/housekeeping/files.js';

// One rule for which upload blobs (`backups/blobs/<sha256>`) may go (1d T20-BLOB-RULE-THREE-COPIES; spec §9.9): those
// no kept backup's manifest names, and none at all while a kept backup's manifest cannot be read (its blobs cannot be
// told apart). The three collectors (gcBlobs, the backup retention's collectBlobs, the files cleanup's `blobs` phase)
// all go through referencedBlobs.

const ctx = testDbContext();
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

const BLOB_A = 'a'.repeat(64);
const BLOB_B = 'b'.repeat(64);
const BLOB_C = 'c'.repeat(64);

describe.skipIf(!ctx.available)(`referenced blobs [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-blob-refs-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  /** A finished backup naming `blobs`: its `ok` row and its manifest. */
  async function keptBackup(blobs: string[]): Promise<string> {
    const id = newId();
    const now = Date.now();
    await h.db
      .insertInto('backups')
      .values({ id, kind: 'manual', size: 1, sha256: 'd'.repeat(64), schema_version: '0009', app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'ok', created_at: now })
      .execute();
    const manifest: BackupManifest = {
      format: 'altis-backup/1',
      backupId: id,
      kind: 'manual',
      appVersion: '0.1.0',
      schemaVersion: '0009_ops_jobs',
      dialect: h.dialect,
      createdAt: now,
      consistency: 'snapshot',
      kids: ['k1'],
      installId: newId(),
      auditHead: { seq: 0, hash: '0'.repeat(64) },
      includesFiles: true,
      secrets: 'keyring',
      tables: {},
      blobs: blobs.map((sha256) => ({ sha256, size: 1 })),
      hmac: 'x',
    };
    await writeManifest(dataDir, manifest);
    return id;
  }

  const blobFile = (sha256: string) => path.join(dataDir, 'backups', 'blobs', sha256);
  const blobsLeft = async (): Promise<string[]> => (await fsp.readdir(path.join(dataDir, 'backups', 'blobs'))).sort();
  const putBlobs = async (): Promise<void> => {
    for (const sha256 of [BLOB_A, BLOB_B, BLOB_C]) await fsp.writeFile(blobFile(sha256), 'x');
  };
  const kept = () => h.db.selectFrom('backups').select('id').where('status', '=', 'ok').orderBy('id').execute();
  const unreadable = (id: string) => fsp.writeFile(path.join(dataDir, 'backups', id, 'manifest.json'), '{"not": "a manifest"');

  /** The three collectors, each run alone on the same DATA_DIR. */
  const collectors: [string, () => Promise<unknown>][] = [
    ['gcBlobs', async () => gcBlobs(dataDir, await kept(), silent)],
    ['collectBlobs (the backup retention)', () => collectBlobs(h, dataDir, silent)],
    [
      "the files cleanup's blobs phase (unusedBlobs)",
      () => cleanFiles(h, { dataDir, now: Date.now(), from: { phase: 'blobs', after: null }, budgetLeft: () => true, owner: `job:${newId()}`, log: silent }),
    ],
  ];

  beforeEach(async () => {
    await h.db.deleteFrom('backups').execute();
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('locks').execute();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-blob-refs-')));
    await fsp.mkdir(path.join(dataDir, 'backups', 'blobs'), { recursive: true });
    first = await keptBackup([BLOB_A]);
    second = await keptBackup([BLOB_B]);
    await putBlobs();
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('referencedBlobs: the blobs the readable manifests name, and the kept backups whose manifest cannot be read', async () => {
    expect(await referencedBlobs(dataDir, [{ id: first }, { id: second }])).toEqual({ blobs: new Set([BLOB_A, BLOB_B]), unreadable: [] });
    await unreadable(second);
    const missing = newId(); // a kept row whose folder is gone
    const notAnId = '../evil';
    expect(await referencedBlobs(dataDir, [{ id: first }, { id: second }, { id: missing }, { id: notAnId }])).toEqual({
      blobs: new Set([BLOB_A]),
      unreadable: [second, missing, notAnId],
    });
  });

  it.each(collectors)('%s: one kept manifest unreadable → no blob goes', async (_name, collect) => {
    await unreadable(second);
    await collect();
    expect(await blobsLeft()).toEqual([BLOB_A, BLOB_B, BLOB_C]);
  });

  it.each(collectors)('%s: a kept backup without a manifest → no blob goes', async (_name, collect) => {
    await fsp.rm(path.join(dataDir, 'backups', second, 'manifest.json'));
    await collect();
    expect(await blobsLeft()).toEqual([BLOB_A, BLOB_B, BLOB_C]);
  });

  it.each(collectors)('%s: every kept manifest readable → only the blob none names (c) goes', async (_name, collect) => {
    await collect();
    expect(await blobsLeft()).toEqual([BLOB_A, BLOB_B]);
  });
});
