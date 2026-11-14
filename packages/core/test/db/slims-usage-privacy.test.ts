import fsp from 'node:fs/promises';
import path from 'node:path';
import { listCatalogTables } from '@altis/db';
import { dataPath, runWorkPath } from '@altis/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { slimsFixtureBytes } from '../support/slims-fixture/index.js';
import type { UsageExpectation } from '../support/slims-fixture/generate-usage.js';
import { usageHarness, workFolderExists, type UsageHarness } from './slims-usage-support.js';

// The SLiMS usage import never keeps anyone's identity (spec §11.2, §12.4): SLiMS dumps hold member names, addresses,
// institutions and member numbers. The raw dump is deleted as soon as its usage tables are staged; from then on only
// months, keyed hashes, codes and counts reach the disk, and after the end no value of the fixture's people is in any
// table. The fixture's personal values (every one holds a space, `-` or `@`) are looked for byte by byte.

const ctx = testDbContext();

/** Every file under `dir`, recursively: path → bytes. */
async function filesUnder(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.set(p, await fsp.readFile(p));
    }
  };
  await walk(dir);
  return out;
}

/** The personal values found in the files under `dir` (as UTF-8 or Latin-1 text), as `file: value`. */
async function personalInFiles(dir: string, values: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const [file, bytes] of await filesUnder(dir)) {
    const texts = [bytes.toString('utf8'), bytes.toString('latin1')];
    for (const value of values) if (texts.some((text) => text.includes(value))) found.push(`${path.basename(file)}: ${value}`);
  }
  return found;
}

describe.skipIf(!ctx.available)(`SLiMS usage import privacy [${engineLabel()}]`, () => {
  let t: UsageHarness;
  let dump: Buffer;
  let expected: UsageExpectation;
  let periodId: string;

  beforeAll(async () => {
    t = await usageHarness('slims-usage-privacy');
    const fixture = slimsFixtureBytes(undefined, { usage: { period: { startsOn: '2025-07-01', endsOn: '2026-06-30' } } });
    dump = fixture.dump;
    expected = fixture.hooks.usage!;
    periodId = await t.period('2025-07-01', '2026-06-30');
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'catalog_runs', 'usage_stats', 'usage_group_map'] as const) await t.h.db.deleteFrom(table).execute();
  });

  it('the fixture dump holds the personal values the scans look for', () => {
    expect(expected.personalValues.length).toBeGreaterThan(300);
    const text = dump.toString('utf8');
    expect(expected.personalValues.filter((v) => !text.includes(v))).toEqual([]);
  });

  it('the dump and its upload are gone at the first slice after the split; no personal value is in tmp/ then, after a slice that stops in the visits, nor after the end; none is in any table', async () => {
    const uploadId = await t.upload(dump);
    const { runId, jobId } = await t.start(periodId, { source: { kind: 'dump', uploadId } });
    const tmp = dataPath(t.dataDir, 'tmp');
    // The upload was taken and moved into the run's folder: the raw dump is there until the split ends.
    expect(await fsp.stat(runWorkPath(t.dataDir, runId, 'dump.bin')).then(() => true)).toBe(true);

    let splitSlices = 0;
    while ((await t.payload(jobId)).phase === 'split') {
      expect((await t.slice(jobId, 0)).outcome).toBe('continued');
      splitSlices += 1;
    }
    expect(splitSlices).toBeGreaterThan(0);
    await expect(fsp.stat(runWorkPath(t.dataDir, runId, 'dump.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(tmp, uploadId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await personalInFiles(tmp, expected.personalValues)).toEqual([]);

    // On to a slice that stops inside the visits.
    for (let i = 0; i < 1_000; i += 1) {
      const p = await t.payload(jobId);
      if (p.phase === 'visits' && p.cursor !== null && p.cursor !== undefined) break;
      expect((await t.slice(jobId, 0)).outcome).toBe('continued');
    }
    expect((await t.payload(jobId)).phase).toBe('visits');
    expect((await fsp.readdir(path.join(tmp, runId))).some((n) => /^usage-visits-\d{4}-\d{2}\.bin$/.test(n))).toBe(true);
    expect(await personalInFiles(tmp, expected.personalValues)).toEqual([]);

    expect(await t.runToEnd(jobId)).toBe('succeeded');
    expect(await workFolderExists(t.dataDir, runId)).toBe(false);
    expect(await personalInFiles(tmp, expected.personalValues)).toEqual([]);
    // The run's report, and anything else the import left in DATA_DIR, too.
    expect(await personalInFiles(t.dataDir, expected.personalValues)).toEqual([]);

    // Every table, every column: `jobs.payload` and `catalog_runs.summary` included.
    const found: string[] = [];
    const tables = await listCatalogTables(t.h);
    expect(tables).toEqual(expect.arrayContaining(['usage_stats', 'usage_group_map', 'jobs', 'catalog_runs', 'audit_log', 'files']));
    for (const table of tables) {
      const rows = await t.h.db.selectFrom(table as 'jobs').selectAll().execute();
      for (const row of rows) {
        const text = Object.values(row as Record<string, unknown>)
          .map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v)))
          .join('\u0000');
        for (const value of expected.personalValues) if (text.includes(value)) found.push(`${table}: ${value}`);
      }
    }
    expect(found).toEqual([]);
    const jobRow = await t.h.db.selectFrom('jobs').select(['payload', 'secret_param']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(jobRow.secret_param).toBeNull();
    expect((await t.run(runId)).summary).not.toMatch(/[0-9a-f]{32}/);
  });

  it('a cancel during the split leaves no dump, no staging and no upload behind', async () => {
    const uploadId = await t.upload(dump);
    const { runId, jobId } = await t.start(periodId, { source: { kind: 'dump', uploadId } });
    // A slice with no time left still splits for a moment; how much it stages in that moment depends on the machine, so
    // slices run until the first staged table exists, the split still unfinished.
    const staged = async (): Promise<boolean> =>
      (await fsp.readdir(dataPath(t.dataDir, 'tmp', runId)).catch(() => [] as string[])).some((n) => n.endsWith('.ndjson'));
    for (let i = 0; i < 200 && !(await staged()); i += 1) {
      expect((await t.slice(jobId, 0)).outcome).toBe('continued');
      expect((await t.payload(jobId)).phase).toBe('split');
    }
    expect((await t.payload(jobId)).phase).toBe('split');
    expect(await staged()).toBe(true);
    expect((await t.slice(jobId, 0, { cancel: true })).outcome).toBe('cancelled');
    expect((await t.run(runId)).status).toBe('cancelled');
    expect(await workFolderExists(t.dataDir, runId)).toBe(false);
    await expect(fsp.stat(dataPath(t.dataDir, 'tmp', uploadId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await personalInFiles(dataPath(t.dataDir, 'tmp'), expected.personalValues)).toEqual([]);
    expect(await t.stats()).toEqual([]);
  });
});
