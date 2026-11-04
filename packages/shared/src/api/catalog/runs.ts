/**
 * The catalog runs API vocabulary (Phase 2 spec §2.2 `catalog_runs`, §3.3, §5.4, §12.2; plan Tasks 19, 29): imports,
 * exports, SLiMS migrations and duplicate scans, each a run with a job, a summary and a report. A migration run is
 * 404 to anyone without `catalog.migration.run` (decision P2-27).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/runs`.
 */
import { z } from 'zod';
import { RUN_KINDS, type RunKind, type RunStatus } from '../../catalog-vocab.js';
import type { JobStatusValue } from '../jobs.js';
import { cursorQuery, type Paged } from './common.js';

/** One run. `options` never holds a secret; `summary` is the run's counters (`ImportSummary`, `MigrationSummary`, …). */
export interface RunView {
  id: string;
  kind: RunKind;
  status: RunStatus;
  dryRun: boolean;
  /** The import or export format, or null. */
  format: string | null;
  options: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  /** The CSV report (streamed by `GET catalog/runs/:id/report`, never by `/files/:id`, S18). */
  reportFileId: string | null;
  /** An export's file name and size while it can be downloaded (`GET catalog/runs/:id/download`). */
  outputName: string | null;
  outputSize: number | null;
  /** When an export's file goes away (410 `CATALOG_RUN_EXPIRED` after it). */
  expiresAt: number | null;
  jobId: string | null;
  /**
   * The status of the run's job (null when it has none any more). C17: a run still `queued` or `running` whose job
   * ended (cancelled while queued, dead) is not live: nothing moves it any more, and the next start or the daily
   * housekeeping ends it as its job ended. Optional for older answers; the server always sends it.
   */
  jobStatus?: JobStatusValue | null;
  createdAt: number;
  createdBy: string | null;
  finishedAt: number | null;
}

/** `GET catalog/runs?kind=`: newest first. */
export const RunListQuery = z.strictObject({ kind: z.enum(RUN_KINDS).optional(), ...cursorQuery });

export type RunListQuery = z.infer<typeof RunListQuery>;

/** `GET catalog/runs`. */
export type RunListResponse = Paged<RunView>;

/** `POST catalog/dedupe-scans`: no options. */
export const DedupeScanBody = z.strictObject({});

export type DedupeScanBody = z.infer<typeof DedupeScanBody>;

/** The answer of a route that starts a run: the run and its job (follow it on `jobs.<jobId>`). */
export interface RunStarted {
  runId: string;
  jobId: string;
}

/** Why records were grouped by the duplicate scan (§3.3: no fuzzy matching). */
export type DedupeGroupReason = 'isbn' | 'title_year';

/** The summary of a duplicate scan: group counts and the first 200 groups (the report CSV has every row). */
export interface DedupeScanSummary {
  groups: { isbn: number; title_year: number };
  records: number;
  preview: { reason: DedupeGroupReason; recordIds: string[] }[];
}
