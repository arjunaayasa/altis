import { withTx, type DbHandle } from '@altis/db';
import { dataPath, exportFilePath, listNames, removeFile, removeStaleTemps, removeTree, runWorkDir, statOrNull, type ExportFileExt } from '@altis/platform';
import { isUlid, ulidTime } from '@altis/shared';
import { errorFields } from '../../context.js';
import { closeAbandonedSlimsRun } from '../../migration/slims/ending.js';
import { RUN_WORK_KEEP_MS, finishRun, type RunEnd } from '../data/runs.js';
import type { CatalogHousekeepingStep, HousekeepingStepContext } from '../housekeeping.js';
import { exportFileExtOf } from './queries.js';

// The expired-exports step of `catalog.housekeeping` (Phase 2 spec §5.4, §12.6; plan Task 19, S2, S3). It works in
// four phases, item by item, and stops after any item once the slice's budget runs low, returning the cursor
// `<phase>:<last item>` the next slice continues from (the first item of a call always runs). Every item is
// idempotent, so a slice killed anywhere repeats at most one item. A cursor this step did not write starts it over.
//
//   runs     A run still `queued` or `running` whose job ended (dead, cancelled, or succeeded without ending it) is
//            ended as its job did: `failed`, or `cancelled` for a cancelled job, at the time its job ended. Otherwise
//            it would hold its work folder forever (S2 keeps the folders of live runs) and show as running. A duplicate
//            scan and a migration are ended at once (their jobs are never retried through the API: a migration's is
//            `origin-only`, C17); any other kind only 7 days after its job ended, so that a dead import an admin
//            retries meanwhile still finds its run live. A run whose job is gone (retention) or never attached is
//            ended `failed` once it is 7 days old. A migration run ended here gets what its pipeline's end would have
//            written (migration/slims/ending.ts: the search index `ready`, `catalog.migration.finish`), and its work
//            folder goes at once (no real run adopts a run that did not succeed).
//   expired  An export whose file expired (`expires_at` ≤ now) loses the file `exports/<runId>.<ext>`, and its
//            `output_name` and `output_size` are cleared: the download answers 410 CATALOG_RUN_EXPIRED from
//            `expires_at` on anyway.
//   files    Leftovers in `exports/`: a file `<runId>.<ext>` whose run is a finished export without that file to serve
//            (failed, cancelled, expired, another extension) goes at once; one that names no export run goes once
//            its id is 24 hours old. Temporary siblings an interrupted write left (`.<name>.tmp-…`) go after 24 hours.
//            Any other name is left alone.
//   work     The work folder `tmp/<runId>/` of a run that finished more than RUN_WORK_KEEP_MS (7 days) ago (S2): the
//            age past which a dry run's input can no longer be adopted by its real run (S3). A folder of a live run,
//            of a run finished less than 7 days ago, or that names no run (an upload session's, an op's) stays.

const DAY = 86_400_000;
/** A file in `exports/` that names no export run is left this long (by its id's time). */
const ORPHAN_EXPORT_MS = DAY;
/** Below this much budget left, no further item starts in this call. */
const ITEM_MARGIN_MS = 2000;
/** Rows or names looked at per query. */
const BATCH = 200;

const PHASES = ['runs', 'expired', 'files', 'work'] as const;
type Phase = (typeof PHASES)[number];

const EXPORT_EXTS: readonly ExportFileExt[] = ['mrc', 'xml', 'jsonl', 'csv'];
const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);
const JOB_TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'dead', 'cancelled']);
/** An export file's name: the run id and one of the export extensions. */
const EXPORT_NAME = /^([0-9A-Z]{26})\.(mrc|xml|jsonl|csv)$/;

/** Whether to stop before the next item (never before the first item of a call). */
type Stop = () => boolean;

/** The phase and position `cursor` names; the start for null or a cursor this step did not write. */
function parseCursor(cursor: string | null): { index: number; after: string } {
  const m = cursor === null ? null : /^([a-z]+):(.*)$/s.exec(cursor);
  const index = m === null ? -1 : PHASES.indexOf(m[1] as Phase);
  return index < 0 ? { index: 0, after: '' } : { index, after: m![2]! };
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const numOrNull = (v: number | string | bigint | null): number | null => (v === null ? null : Number(v));

/** Phase `runs`: live runs whose job ended (see the top of this file). */
async function endAbandonedRuns(c: HousekeepingStepContext, after: string, stop: Stop): Promise<string | null> {
  const h: DbHandle = c.h;
  for (let last = after; ; ) {
    let q = h.db
      .selectFrom('catalog_runs as r')
      .leftJoin('jobs as j', 'j.id', 'r.job_id')
      .select([
        'r.id',
        'r.kind',
        'r.created_at',
        'r.summary',
        'r.report_file_id',
        'r.output_name',
        'r.output_size',
        'r.expires_at',
        'r.dry_run',
        'j.id as job_id',
        'j.status as job_status',
        'j.finished_at as job_finished_at',
        'j.updated_at as job_updated_at',
      ])
      .where('r.status', 'in', ['queued', 'running']);
    if (last !== '') q = q.where('r.id', '>', last);
    const rows = await q.orderBy('r.id').limit(BATCH).execute();
    if (rows.length === 0) return null;
    for (const r of rows) {
      if (stop()) return last;
      last = r.id;
      let end: { status: RunEnd; at: number } | null = null;
      if (r.job_id === null || r.job_status === null) {
        if (Number(r.created_at) <= c.now - RUN_WORK_KEEP_MS) end = { status: 'failed', at: c.now };
      } else if (JOB_TERMINAL.has(r.job_status)) {
        const endedAt = Number(r.job_finished_at ?? r.job_updated_at ?? c.now);
        const grace = r.kind === 'dedupe_scan' || r.kind === 'migration' ? 0 : RUN_WORK_KEEP_MS;
        if (endedAt <= c.now - grace) end = { status: r.job_status === 'cancelled' ? 'cancelled' : 'failed', at: endedAt };
      }
      if (end === null) continue;
      const ending = end;
      const migration = r.kind === 'migration';
      const ended = await withTx(h, async (trx) => {
        const done = await finishRun(
          trx,
          r.id,
          {
            status: ending.status,
            summary: jsonObject(r.summary),
            reportFileId: r.report_file_id,
            outputName: r.output_name,
            outputSize: numOrNull(r.output_size),
            expiresAt: numOrNull(r.expires_at),
          },
          ending.at,
        );
        if (done && migration) {
          await closeAbandonedSlimsRun(trx, { runId: r.id, jobId: r.job_id, status: ending.status, dryRun: Number(r.dry_run) === 1, now: c.now });
        }
        return done;
      });
      if (ended && migration) {
        await removeTree(runWorkDir(c.deps.dataDir, r.id)).catch((error: unknown) => {
          c.deps.log.warn('catalog housekeeping: the work folder of an ended migration run could not be removed', { runId: r.id, ...errorFields(error) });
        });
      }
    }
  }
}

/** Removes every export file `exports/<runId>.<ext>` of run `runId`, whatever its extension. */
async function removeExportFiles(dataDir: string, runId: string): Promise<void> {
  for (const ext of EXPORT_EXTS) await removeFile(exportFilePath(dataDir, runId, ext));
}

/** Phase `expired`: expired export files and their `output_name`. */
async function removeExpiredExports(c: HousekeepingStepContext, after: string, stop: Stop): Promise<string | null> {
  for (let last = after; ; ) {
    let q = c.h.db
      .selectFrom('catalog_runs')
      .select('id')
      .where('kind', '=', 'export')
      .where('output_name', 'is not', null)
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', c.now);
    if (last !== '') q = q.where('id', '>', last);
    const rows = await q.orderBy('id').limit(BATCH).execute();
    if (rows.length === 0) return null;
    for (const r of rows) {
      if (stop()) return last;
      last = r.id;
      // The file first: a slice killed in between finds the row again and removes nothing more.
      await removeExportFiles(c.deps.dataDir, r.id);
      await withTx(c.h, (trx) =>
        trx.updateTable('catalog_runs').set({ output_name: null, output_size: null }).where('id', '=', r.id).where('output_name', 'is not', null).execute(),
      );
    }
  }
}

/** Phase `files`: leftover files in `exports/`. */
async function removeLeftoverExports(c: HousekeepingStepContext, after: string, stop: Stop): Promise<string | null> {
  const dir = dataPath(c.deps.dataDir, 'exports');
  if (after === '') await removeStaleTemps(dir, { now: c.now, olderThanMs: DAY });
  const names = (await listNames(dir)).filter((n) => n > after && EXPORT_NAME.test(n));
  let last = after;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const ids = [...new Set(batch.map((n) => EXPORT_NAME.exec(n)![1]!).filter(isUlid))];
    const runs = new Map(
      ids.length === 0
        ? []
        : (
            await c.h.db
              .selectFrom('catalog_runs')
              .select(['id', 'kind', 'status', 'format', 'output_name', 'expires_at'])
              .where('id', 'in', ids)
              .execute()
          ).map((r) => [r.id, r] as const),
    );
    for (const name of batch) {
      if (stop()) return last;
      last = name;
      const [, id, ext] = EXPORT_NAME.exec(name)!;
      if (!isUlid(id!)) continue;
      const run = runs.get(id!);
      let remove: boolean;
      if (run === undefined || run.kind !== 'export') {
        remove = ulidTime(id!) <= c.now - ORPHAN_EXPORT_MS;
      } else if (!TERMINAL.has(run.status)) {
        remove = false;
      } else {
        const expired = run.expires_at !== null && Number(run.expires_at) <= c.now;
        remove = run.output_name === null || expired || exportFileExtOf(run.format) !== ext;
      }
      if (!remove) continue;
      const file = exportFilePath(c.deps.dataDir, id!, ext as ExportFileExt);
      if ((await statOrNull(file))?.kind === 'file') await removeFile(file);
    }
  }
  return null;
}

/** Phase `work`: the work folders of runs finished more than 7 days ago (S2). */
async function removeOldWorkFolders(c: HousekeepingStepContext, after: string, stop: Stop): Promise<string | null> {
  const names = (await listNames(dataPath(c.deps.dataDir, 'tmp'))).filter((n) => n > after && isUlid(n));
  let last = after;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const runs = new Map(
      (await c.h.db.selectFrom('catalog_runs').select(['id', 'status', 'finished_at', 'created_at']).where('id', 'in', batch).execute()).map(
        (r) => [r.id, r] as const,
      ),
    );
    for (const id of batch) {
      if (stop()) return last;
      last = id;
      const run = runs.get(id);
      if (run === undefined || !TERMINAL.has(run.status)) continue;
      if (Number(run.finished_at ?? run.created_at) > c.now - RUN_WORK_KEEP_MS) continue;
      await removeTree(runWorkDir(c.deps.dataDir, id));
    }
  }
  return null;
}

const PHASE_RUN: Readonly<Record<Phase, (c: HousekeepingStepContext, after: string, stop: Stop) => Promise<string | null>>> = {
  runs: endAbandonedRuns,
  expired: removeExpiredExports,
  files: removeLeftoverExports,
  work: removeOldWorkFolders,
};

/**
 * The expired-exports step of `catalog.housekeeping` (spec §5.4, S2; see the top of this file): an export file past
 * its `expires_at` is removed (its download then answers 410 `CATALOG_RUN_EXPIRED`), so are leftover export files, and
 * the work folder (`tmp/<runId>/`) of a run that finished more than 7 days ago; a run whose job ended without it is
 * ended first.
 */
export const expiredExportsStep: CatalogHousekeepingStep = Object.freeze({
  name: 'expired_exports',
  async run(c: HousekeepingStepContext): Promise<{ done: boolean; cursor: string | null }> {
    const start = parseCursor(c.cursor);
    let worked = false;
    const stop: Stop = () => {
      if (worked && c.budgetLeftMs() < ITEM_MARGIN_MS) return true;
      worked = true;
      return false;
    };
    for (let index = start.index; index < PHASES.length; index += 1) {
      const phase = PHASES[index]!;
      const at = await PHASE_RUN[phase](c, index === start.index ? start.after : '', stop);
      if (at !== null) return { done: false, cursor: `${phase}:${at}` };
    }
    return { done: true, cursor: null };
  },
});
