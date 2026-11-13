import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { dataPath, runWorkDir } from '@altis/platform';
import { endOfMonth, newId } from '@altis/shared';
import type { SlimsUsageStartBody } from '@altis/shared/api/accreditation';
import { expect } from 'vitest';
import { testDb, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { importSlimsUsageJob } from '../../src/accreditation/slims-usage/job.js';
import { startSlimsUsageImport, type SlimsUsageStarted } from '../../src/accreditation/slims-usage/start.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { takeStagedUpload, uploadOwner } from '../../src/files/uploads.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { requestCancel } from '../../src/jobs/service.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { SliceResult } from '../../src/jobs/types.js';
import { placeSlimsWork } from '../../src/migration/slims/pipeline.js';
import type { ReportJobDeps } from '../../src/reports/export/job.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import type { UsageExpectation } from '../support/slims-fixture/generate-usage.js';

// What the SLiMS usage import's DB tests share: an installation with a staff user, its DATA_DIR, accreditation periods
// written straight into their table, dump uploads staged as the upload API leaves them, a start as the route makes it
// (the run, the job, the upload taken in the same transaction, the dump moved into the run's folder after the COMMIT),
// the job's slices, and the comparison of the usage rows with the synthetic fixture's hand count.

/** In the past: an audit entry may not be dated ahead of the real clock. */
export const NOW = Date.UTC(2026, 10, 12, 8, 0, 0);
export const silent: CoreLogger = { info() {}, warn() {}, error() {} };
export const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];

/** One `usage_stats` row as the comparisons read it. */
export interface StatRow {
  source: string;
  metric: string;
  span_from: string;
  span_to: string;
  group_key: string;
  value: number;
}

export interface UsageHarness {
  h: TestDbHandle;
  root: string;
  dataDir: string;
  staffId: string;
  deps(): ReportJobDeps;
  /** A period of the accreditation workspace (written straight into its table). */
  period(startsOn: string, endsOn: string): Promise<string>;
  /** A completed `accreditation.slims_dump` upload of the staff user holding `bytes`. */
  upload(bytes: Uint8Array): Promise<string>;
  /** Starts an import from `periodId` as the route does; the upload of a dump source is taken and placed. */
  start(periodId: string, body: SlimsUsageStartBody): Promise<SlimsUsageStarted>;
  /**
   * Claims job `jobId` and runs one slice of `budgetMs` (on a clock that stands still). `cancel`: a cancel is
   * requested once the job is claimed (the running slice's heartbeat sees it).
   */
  slice(jobId: string, budgetMs?: number, o?: { cancel?: boolean }): Promise<SliceResult>;
  /** Runs slices of `budgetMs` until the job stops continuing; its last outcome. */
  runToEnd(jobId: string, budgetMs?: number): Promise<string>;
  /** The job's stored payload. */
  payload(jobId: string): Promise<{ phase?: string; cursor?: string | null; state?: unknown }>;
  run(runId: string): Promise<{ status: string; summary: string; report_file_id: string | null; options: string }>;
  /** Every `usage_stats` row, in key order. */
  stats(): Promise<StatRow[]>;
  close(): Promise<void>;
}

/** An installation for the usage import tests (`label`: the temporary folder's name part). */
export async function usageHarness(label: string): Promise<UsageHarness> {
  const h = await testDb();
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${label}-`)));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  const staffId = newId(NOW);
  await h.db
    .insertInto('staff_users')
    .values({ id: staffId, username_key: 'PUSTAKAWAN', username_display: 'pustakawan', name: 'pustakawan', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
    .execute();
  const deps = (): ReportJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(dataDir), log: silent, appVersion: '0.1.0' });
  const registry = createJobRegistry([importSlimsUsageJob(deps)]);

  const harness: UsageHarness = {
    h,
    root,
    dataDir,
    staffId,
    deps,
    async period(startsOn, endsOn) {
      const id = newId(NOW);
      await h.db
        .insertInto('accred_periods')
        .values({
          id,
          branch_id: null,
          name: `Periode ${startsOn}`,
          kind: 'school_year',
          starts_on: startsOn,
          ends_on: endsOn,
          instrument_id: 'test-sch',
          status: 'open',
          frozen_at: null,
          frozen_by: null,
          profile: '{}',
          students: null,
          teachers: null,
          edu_staff: null,
          classes: null,
          population_served: null,
          teachers_using: null,
          user_pcs: null,
          staff_pcs: null,
          ict_devices: null,
          scanners: null,
          floor_m2: null,
          bandwidth_mbps: null,
          hours_per_week: null,
          services: null,
          external_website_url: null,
          created_at: NOW,
          updated_at: NOW,
          created_by: staffId,
          updated_by: staffId,
          version: 1,
          archived_at: null,
        })
        .execute();
      return id;
    },
    async upload(bytes) {
      const id = newId(NOW);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await h.db
        .insertInto('upload_sessions')
        .values({
          id,
          owner: `staff:${staffId}`,
          context: 'accreditation.slims_dump',
          size: bytes.byteLength,
          sha256,
          chunk_size: 262_144,
          received: bytes.byteLength,
          expires_at: NOW + 86_400_000,
        })
        .execute();
      const dir = dataPath(dataDir, 'tmp', id);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'upload.bin'), bytes);
      await fsp.writeFile(path.join(dir, '.complete'), JSON.stringify({ size: bytes.byteLength, sha256, mime: 'text/plain' }));
      return id;
    },
    async start(periodId, body) {
      const started = await withTx(h, async (trx) => {
        const s = await startSlimsUsageImport(trx, periodId, body, { now: NOW, createdBy: staffId, registry, keyring, settings: await loadAccredSettings(trx) });
        if (!s.joined && body.source.kind === 'dump') {
          await takeStagedUpload(trx, { uploadId: body.source.uploadId, owner: uploadOwner(staffId), context: 'accreditation.slims_dump', dataDir });
        }
        return s;
      });
      if (!started.joined && body.source.kind === 'dump') {
        await placeSlimsWork(dataDir, started.runId, { fromRunId: null, dumpStagingId: body.source.uploadId, filesStagingId: null });
      }
      return started;
    },
    async slice(jobId, budgetMs = 20_000, o = {}) {
      const job = await claimById(h, registry, jobId, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${jobId} cannot be claimed`);
      if (o.cancel === true) expect(await withTx(h, (trx) => requestCancel(trx, jobId, NOW))).toBe('requested');
      return runSlice(h, registry, job, { mode: 'worker', budgetMs, keyring, log: silent, clock: () => NOW, env: {} });
    },
    async runToEnd(jobId, budgetMs = 20_000) {
      for (let i = 0; i < 5_000; i += 1) {
        const r = await harness.slice(jobId, budgetMs);
        if (r.outcome !== 'continued') return r.outcome;
      }
      throw new Error(`job ${jobId} did not end within 5 000 slices`);
    },
    async payload(jobId) {
      const row = await h.db.selectFrom('jobs').select('payload').where('id', '=', jobId).executeTakeFirstOrThrow();
      return JSON.parse(row.payload) as { phase?: string; cursor?: string | null; state?: unknown };
    },
    run: (runId) => h.db.selectFrom('catalog_runs').select(['status', 'summary', 'report_file_id', 'options']).where('id', '=', runId).executeTakeFirstOrThrow(),
    async stats() {
      const rows = await h.db
        .selectFrom('usage_stats')
        .select(['source', 'metric', 'span_from', 'span_to', 'group_key', 'value'])
        .orderBy('source')
        .orderBy('metric')
        .orderBy('span_from')
        .orderBy('span_to')
        .orderBy('group_key')
        .execute();
      return rows.map((r) => ({ ...r, value: Number(r.value) }));
    },
    async close() {
      await h.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}

/** The run folder `tmp/<runId>/` of `runId` exists. */
export async function workFolderExists(dataDir: string, runId: string): Promise<boolean> {
  return fsp
    .stat(runWorkDir(dataDir, runId))
    .then(() => true)
    .catch(() => false);
}

/**
 * Checks the `slims` rows of `rows` against the fixture's hand count `expected`: every month row and span row holds the
 * expected count (0 for a cell the count does not list), every non-zero cell of the count has its row, and every month
 * between the first and the last carries its totals. `cutoverOn`: the cut month's row ends the day before it.
 */
export function expectRowsMatch(rows: readonly StatRow[], expected: UsageExpectation, cutoverOn: string | null = null): void {
  const slims = rows.filter((r) => r.source === 'slims');
  const monthTo = (month: string): string =>
    cutoverOn !== null && cutoverOn.slice(0, 7) === month ? new Date(Date.parse(`${cutoverOn}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : endOfMonth(month);
  const spanIndex = (r: StatRow): 0 | 1 | 2 | null => {
    const i = expected.spans.findIndex((s) => s.from === r.span_from && s.to === r.span_to);
    return i < 0 ? null : (i as 0 | 1 | 2);
  };
  const seen = new Set<string>();
  for (const r of slims) {
    const month = r.span_from.slice(0, 7);
    const isMonth = r.span_from === `${month}-01` && r.span_to === monthTo(month) && expected.months.includes(month);
    const span = spanIndex(r);
    expect(isMonth || span !== null, `a slims row outside the expected months and spans: ${JSON.stringify(r)}`).toBe(true);
    const want = isMonth ? expected.cell(month, r.metric, r.group_key) : expected.spanCell(span!, r.metric, r.group_key);
    expect(r.value, `${r.metric} ${r.span_from}..${r.span_to} [${r.group_key}]`).toBe(want);
    seen.add(`${r.metric}|${r.span_from}|${r.span_to}|${r.group_key}`);
  }
  for (const month of expected.months) {
    for (const [metric, groups] of Object.entries(expected.monthly[month] ?? {})) {
      for (const group of Object.keys(groups)) {
        expect(seen.has(`${metric}|${month}-01|${monthTo(month)}|${group}`), `missing ${metric} ${month} [${group}]`).toBe(true);
      }
    }
    for (const metric of ['visits', 'visits_deduped', 'loans']) {
      expect(seen.has(`${metric}|${month}-01|${monthTo(month)}|`), `missing total ${metric} ${month}`).toBe(true);
    }
  }
  expected.spans.forEach((span, k) => {
    for (const [metric, groups] of Object.entries(expected.spanCells[k]!)) {
      for (const group of Object.keys(groups)) {
        expect(seen.has(`${metric}|${span.from}|${span.to}|${group}`), `missing span ${k} ${metric} [${group}]`).toBe(true);
      }
    }
  });
}
