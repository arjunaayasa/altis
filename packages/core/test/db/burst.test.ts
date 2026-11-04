import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, connect, runMigrations, verifyAuditChain, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { txCtx } from '../../src/context.js';
import { BACKUP_CREATE_JOB, backupCreateJob, type BackupJobDeps } from '../../src/backup/create-job.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { closeJobSessions, runSlice } from '../../src/jobs/slice.js';
import type { SliceResult } from '../../src/jobs/types.js';

// L41 (nightly, MySQL/MariaDB/PostgreSQL; ALTIS_TEST_NIGHTLY=1): one DbHandle per process plus the snapshot backup's
// dedicated connection (P17). While a snapshot backup holds its read-only transaction open across its slices, 32
// concurrent transactions on the live handle each append an audit entry: all of them finish within 30 s (no pool
// starvation, no lock wait on the snapshot), the audit chain verifies, and the backup ends `ok`.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const nightly = process.env['ALTIS_TEST_NIGHTLY'] === '1';
const KEY = new Uint8Array(32).fill(51);
const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 6).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };
const BURST = 32;

describe.skipIf(!ctx.available || !nightly || ctx.engine === 'sqlite')(`burst: snapshot backup and 32 audit writers [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  const deps = (): BackupJobDeps => ({
    dataDir,
    installId: newId(),
    appVersion: '0.1.0',
    sessionKey: KEY,
    kids: ['k1'],
    runtime: 'pm2',
    connectSnapshot: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
    ops: {
      begin() {
        throw new Error('burst: no ops machine');
      },
    } as unknown as BackupJobDeps['ops'],
  });
  const reg = createJobRegistry([backupCreateJob(deps)]);

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-burst-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await closeJobSessions();
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('32 concurrent audit appends finish within 30 s while the snapshot transaction is open; the chain verifies', async () => {
    vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '5');
    const id = (
      await withTx(h, (trx) =>
        enqueue(trx, reg, { type: BACKUP_CREATE_JOB, payload: { backupId: null, kind: 'manual', includeFiles: false, checkpoint: null, snapshot: null } }, { now: Date.now(), keyring: KEYRING }),
      )
    ).id;
    const run = async (): Promise<SliceResult | null> => {
      const job = await claimById(h, reg, id, { worker: 'burst', now: Date.now() });
      return job === null ? null : runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: 2500, keyring: KEYRING, log: silent, clock: () => Date.now(), env: process.env });
    };
    // The first slice opens the snapshot (a session kept in this process) and writes a part.
    expect((await run())?.outcome).toBe('continued');

    const started = Date.now();
    const writers = Array.from({ length: BURST }, (_, i) =>
      withTx(h, (trx) =>
        txCtx(trx, Date.now(), { type: 'system', id: null, ip: null }).audit({ action: 'backup.create', entity: 'job', entityId: id, meta: { burst: i } }),
      ),
    );
    // The backup goes on meanwhile, slice after slice, on its own connection.
    const backup = (async () => {
      for (let r = await run(); r !== null && r.outcome === 'continued'; r = await run());
    })();
    await Promise.all(writers);
    expect(Date.now() - started).toBeLessThan(30_000);
    await backup;
    expect((await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('succeeded');
    expect((await h.db.selectFrom('backups').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('ok');
    expect(await verifyAuditChain(h)).toMatchObject({ ok: true });
    vi.unstubAllEnvs();
  }, 120_000);
});
