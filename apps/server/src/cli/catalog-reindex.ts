import {
  SLICE_BUDGET_MS,
  claimById,
  closeJobSessions,
  createJobRegistry,
  enqueueReindex,
  readMaintenance,
  runSlice,
} from '@altis/core';
import { connect, withTx } from '@altis/db';
import type { Env } from '@altis/platform';
import { DomainError } from '@altis/shared';
import type { AppState } from '../app.js';
import { loadConfig } from '../config.js';
import type { BootContext } from '../index.js';
import { bindJobHandlers, jobHandlers, jobWorkerName, testClockOffsetMs } from '../jobs/runtime.js';
import { createLogger } from '../logger.js';
import { createAppOps } from '../services.js';
import { CliError } from './common.js';
import { notInstalled } from './migrate.js';

// `node app.js catalog:reindex [--json]` (spec §12.6, §4.8; plan Task 15, M15): rebuilds the catalogue's search index.
// It enqueues `catalog.reindex {scope: 'all'}` with the unique key `catalog.reindex:all` (a rebuild already queued or
// running is joined, never doubled: the boot hook's, the route's, the housekeeping's) and drives that job through the
// runner's claim path in this process (claimById, runSlice; mode `cron_cli`), so each slice holds `jobs:heavy` like a
// server runner's and never overlaps a server-side reindex or import. While another process runs a slice of it, the
// command waits for that slice. It prints a progress line per new percentage (none with `--json`) and ends with the
// documents of the index (`--json`: `{ok, command, docs}`). Refused under maintenance (an op runs, or
// `maintenance:on`), as the route is. cli/index.ts prints the result: `--json` as `{ok: true, command, ...result}`,
// otherwise describeCatalogReindex(result).

export interface CatalogReindexOptions {
  /** A progress line for a human (never with `--json`). */
  onProgress?: (text: string) => void;
}

export interface CatalogReindexResult {
  /** The documents in the index once the rebuild ended. */
  docs: number;
}

/** The wait between two looks while another process runs a slice of the job. */
const WAIT_MS = 1000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function underMaintenance(): DomainError {
  return new DomainError('MAINTENANCE', {
    detail:
      'Mode pemeliharaan aktif (sebuah operasi sedang berjalan); coba lagi setelah selesai / ' +
      'Maintenance mode is on (an operation is running); try again once it ends',
  });
}

/** The job's end as the command reports it, when it did not succeed. */
function failureOf(status: string, lastError: string | null): CliError {
  const code = lastError === null ? null : /^([A-Z][A-Z0-9_]*)/.exec(lastError)?.[1];
  return new CliError(
    'REINDEX_FAILED',
    `Indeks pencarian gagal dibangun ulang (tugas ${status}${code === undefined || code === null ? '' : `, ${code}`}) / ` +
      `The search index rebuild failed (job ${status}${code === undefined || code === null ? '' : `, ${code}`})`,
  );
}

/**
 * Rebuilds the search index (see the top of this file). Everything it opens (the database, the job session, op
 * connections) is closed before it returns.
 *
 * @throws DomainError `NOT_INSTALLED` or `MAINTENANCE`; CliError `REINDEX_FAILED` when the job ended otherwise than
 *   succeeded (a failure the queue retries later is reported at once); what loadConfig and connect throw
 */
export async function catalogReindex(ctx: BootContext, env: Env, o: CatalogReindexOptions = {}): Promise<CatalogReindexResult> {
  const offset = testClockOffsetMs(env);
  const clock = (): number => Date.now() + offset;
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') throw notInstalled();
  const log = createLogger({ dataDir: ctx.dataDir, level: config.log.level }).child({ command: 'catalog:reindex' });
  const h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  const state: AppState = { phase: 'ready', db: h, config };
  const ops = createAppOps(state, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock, runtime: ctx.runtime });
  const reg = createJobRegistry(
    bindJobHandlers(jobHandlers(), {
      dataDir: ctx.dataDir,
      runtime: ctx.runtime,
      installId: config.install.id,
      appVersion: ctx.release.version,
      ops,
      config: () => state.config,
      log,
    }),
  );
  const worker = jobWorkerName('cli');
  try {
    if ((await readMaintenance(ctx.dataDir)) !== null) throw underMaintenance();
    const { jobId } = await withTx(h, (trx) =>
      enqueueReindex(trx, reg, { scope: 'all' }, { now: clock(), keyring: config.keyring, createdBy: null }),
    );
    let shown = -1;
    for (;;) {
      const flag = await readMaintenance(ctx.dataDir);
      if (flag !== null && !flag.exemptJobIds.includes(jobId)) throw underMaintenance();
      const job = await claimById(h, reg, jobId, { worker, now: clock(), exempt: flag === null ? null : flag.exemptJobIds });
      if (job === null) {
        const row = await h.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirst();
        if (row === undefined || (row.status !== 'queued' && row.status !== 'running')) break;
        await pause(WAIT_MS); // another process runs a slice of it, or its retry is not due yet
        continue;
      }
      const result = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: SLICE_BUDGET_MS, keyring: config.keyring, log, clock, env });
      const progress = await h.db.selectFrom('jobs').select('progress').where('id', '=', jobId).executeTakeFirst();
      const pct = result.outcome === 'succeeded' ? 100 : Number(progress?.progress ?? 0);
      if (pct !== shown) {
        o.onProgress?.(`catalog:reindex: ${pct}% / ${pct}%`);
        shown = pct;
      }
      // The next slice at once (one session); a failure the queue retries later is reported now.
      if (result.outcome !== 'continued' && result.outcome !== 'lost') break;
    }
    const row = await h.db.selectFrom('jobs').select(['status', 'last_error']).where('id', '=', jobId).executeTakeFirstOrThrow();
    if (row.status !== 'succeeded') throw failureOf(row.status, row.last_error);
    const docs = await h.db.selectFrom('search_doc').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    return { docs: Number(docs.n) };
  } finally {
    await closeJobSessions(log);
    await ops.close();
    await h.close();
  }
}

/** The result for a human, in both languages. */
export function describeCatalogReindex(result: CatalogReindexResult): string {
  return `catalog:reindex: indeks pencarian dibangun ulang, ${result.docs} dokumen / search index rebuilt, ${result.docs} documents`;
}
