import type { DbHandle } from '@altis/db';
import type { StorageDriver } from '../../files/serve.js';
import type { SlimsFilesSource, SlimsSource } from './source/types.js';

// A stage of the SLiMS migration (spec §11.3; Phase 2 Task 3). The framework (Task 23: the job, its checkpoint, the
// counters, the report) runs the stages in order, each across as many slices as it needs: a stage reads its tables in
// keyset batches from `source`, writes through the catalog's data primitives (or only counts, in a dry run), and
// returns `{done: false, cursor}` before the slice's budget ends; the framework keeps the cursor in the job's payload
// and calls the stage again with it, in whichever process claims the job next (P7).
//
// Task 3 fixes these shapes and creates the eight stage files of Tasks 37 and 38 with stub bodies (stages/*.ts);
// `split`, `analyze` and `report` are the framework's own.

/** The stages in their order (§11.3). */
export type SlimsStageName =
  | 'split'
  | 'analyze'
  | 'masters'
  | 'records'
  | 'relations'
  | 'items'
  | 'attachments'
  | 'covers'
  | 'content'
  | 'archive'
  | 'report';

/** The options of a run (the wizard's or the CLI's, §11.2). */
export interface SlimsRunOptions {
  /** The branch the locations and items go to. */
  branchId: string;
  /** §11.4: SLiMS prices are whole rupiah (`major`, ×100), already minor units (`minor`), or not migrated (`skip`). */
  priceMode: 'major' | 'minor' | 'skip';
  /** The `source` of every `migration_map` and `migration_archive` row (S13). */
  sourceName: string;
  /** Migrate into a catalogue that already has live records (§11.2: with the explicit confirmation). */
  allowNonEmpty: boolean;
}

/** Text repairs counted per column (§11.5). */
export type SlimsFixKind = 'nul' | 'backslash' | 'mojibake' | 'cp1252' | 'php' | 'date' | 'year';

/** The reconciliation counts of a run (§11.6), per source table and per column. Bounded by the framework (M6). */
export interface SlimsCounters {
  /** Rows of `table` in the source. */
  source(table: string, n: number): void;
  migrated(table: string, n: number): void;
  /** Duplicates merged into an existing row (authorities). */
  merged(table: string, n: number): void;
  archived(table: string, n: number): void;
  /** Rows of a table this phase does not read ("Fase 3"). */
  unread(table: string, n: number): void;
  /** Rows skipped, by reason code (`already_migrated`, `empty_key`, ...). */
  skipped(table: string, reason: string, n: number): void;
  fix(column: string, kind: SlimsFixKind, n: number): void;
  /** A before/after sample of a repaired value (at most 5 per column are kept in the summary). */
  sample(column: string, before: string, after: string): void;
}

/** One row of the report CSV: what happened to one source row (or to a whole table). */
export interface SlimsReportRow {
  table: string;
  /** The source row's primary key, or null for a table-level row. */
  legacyKey: string | null;
  /** A short code (`missing_file`, `possible_duplicate`, `barcode_nonstandard`, ...). */
  code: string;
  detail: string;
}

/** What a stage gets for one call. */
export interface SlimsStageContext {
  h: DbHandle;
  source: SlimsSource;
  /** The attachments, covers and content images; null without a files source. */
  files: SlimsFilesSource | null;
  runId: string;
  options: SlimsRunOptions;
  /** Count and report, write nothing outside `catalog_runs` and the run's work files. */
  dryRun: boolean;
  /** The slice's clock (epoch ms), read once when the stage's call began: ids, `created_at` and the like. */
  now: number;
  /**
   * The clock now (epoch ms). A batch reads it right before its COMMIT for the OAI datestamp of the records it wrote
   * (`stampChanged`, C14): a slice runs many batches, so `now` is up to a slice's budget old by then.
   */
  clock(): number;
  storage: StorageDriver;
  dataDir: string;
  counters: SlimsCounters;
  report(r: SlimsReportRow): void;
  /** Milliseconds left of the slice's budget: a stage stops before 0 with its cursor. */
  budgetLeftMs(): number;
  /** The job's heartbeat (never inside a transaction of the stage's own). */
  heartbeat(progress: number, message: string): Promise<void>;
}

/** A stage: its name, the source tables it reads (§11.4), and one call of its work from `cursor` (null: the start). */
export interface SlimsStage {
  name: SlimsStageName;
  reads: readonly string[];
  run(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }>;
}

/**
 * A stage whose task has not filled it yet: its name and tables, and a body that refuses to run (a migration through
 * a stub stage must fail loudly rather than finish having migrated nothing).
 */
export function stubStage(name: SlimsStageName, reads: readonly string[]): SlimsStage {
  return Object.freeze({
    name,
    reads: Object.freeze([...reads]),
    async run(): Promise<{ done: boolean; cursor: string | null }> {
      throw new Error(`not implemented (SLiMS stage ${name})`);
    },
  });
}
