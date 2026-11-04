import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { cleanFiles } from '../../src/housekeeping/files.js';

// Phase 2 (catalog), Task 1, preflight S2: the files cleanup's `tmp` phase removes a `tmp/<ulid>/` folder older than
// 24 hours, but a catalog run's work folder `tmp/<runId>/` holds its staging (an import's `import.bin`, a dump's NDJSON,
// `files.bin`, `report.csv`), and appending to a file does not touch the folder's mtime. So a folder whose run is
// queued or running stays, and so does one whose run finished less than 7 days ago (its dry run's input is reused by
// the real run, S3). On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!ctx.available)(`files.cleanup keeps catalog run work folders (S2) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let now: number;

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-files-runs-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('catalog_runs').execute();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-files-runs-')));
    now = Date.now();
  });

  /** A work folder `tmp/<id>/` with a staging file in it, the folder and the file `ageMs` old. */
  async function workFolder(id: string, ageMs: number): Promise<string> {
    const dir = path.join(dataDir, 'tmp', id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'import.bin'), 'x');
    const at = new Date(now - ageMs);
    await fsp.utimes(path.join(dir, 'import.bin'), at, at);
    await fsp.utimes(dir, at, at);
    return dir;
  }

  /** A catalog run `id` in `status`, finished `finishedAgoMs` ago (null: not finished). */
  async function runRow(id: string, status: string, finishedAgoMs: number | null, dryRun = 0): Promise<void> {
    await h.db
      .insertInto('catalog_runs')
      .values({
        id,
        kind: 'import',
        status,
        dry_run: dryRun,
        format: 'marc21',
        options: '{}',
        summary: '{}',
        report_file_id: null,
        output_name: null,
        output_size: null,
        expires_at: null,
        job_id: null,
        created_at: now - 9 * DAY,
        created_by: null,
        finished_at: finishedAgoMs === null ? null : now - finishedAgoMs,
      })
      .execute();
  }

  const exists = (p: string) =>
    fsp.stat(p).then(
      () => true,
      () => false,
    );

  async function cleanTmp(): Promise<number> {
    const { removed, next } = await cleanFiles(h, { dataDir, now, from: { phase: 'tmp', after: null }, budgetLeft: () => true });
    expect(next).toBeNull();
    return removed;
  }

  it('a running run’s folder whose ulid time and mtime are 25 h old survives', async () => {
    const id = newId(now - 25 * HOUR);
    await runRow(id, 'running', null);
    const dir = await workFolder(id, 25 * HOUR);
    expect(await cleanTmp()).toBe(0);
    expect(await exists(path.join(dir, 'import.bin'))).toBe(true);
  });

  it('a queued run keeps its folder too', async () => {
    const id = newId(now - 3 * DAY);
    await runRow(id, 'queued', null);
    const dir = await workFolder(id, 3 * DAY);
    expect(await cleanTmp()).toBe(0);
    expect(await exists(dir)).toBe(true);
  });

  it('a dry run that succeeded 2 days ago keeps its folder; one that failed 8 days ago, and a folder with no run, go', async () => {
    const dry = newId(now - 3 * DAY);
    const failed = newId(now - 9 * DAY);
    const orphan = newId(now - 2 * DAY);
    const fresh = newId(now - HOUR); // younger than 24 h: never a candidate
    await runRow(dry, 'succeeded', 2 * DAY, 1);
    await runRow(failed, 'failed', 8 * DAY);
    const dryDir = await workFolder(dry, 2 * DAY);
    const failedDir = await workFolder(failed, 8 * DAY);
    const orphanDir = await workFolder(orphan, 2 * DAY);
    const freshDir = await workFolder(fresh, HOUR);
    expect(await cleanTmp()).toBe(2);
    expect(await exists(dryDir)).toBe(true);
    expect(await exists(failedDir)).toBe(false);
    expect(await exists(orphanDir)).toBe(false);
    expect(await exists(freshDir)).toBe(true);
  });
});
