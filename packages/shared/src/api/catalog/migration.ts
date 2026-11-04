/**
 * The SLiMS migration API vocabulary (Phase 2 spec §11, §12.2, §12.3; plan Tasks 23, 30, 37, 38). Super admin only
 * (`catalog.migration.run`) with reauth; the bodies carry a database password, so both routes are `idempotency: none`
 * and the password lives only in the job's sealed secret until the run ends.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/migration`.
 */
import { z } from 'zod';
import type { ErrorCode } from '../../errors.js';
import { ulidField } from '../common.js';
import { shortText } from './common.js';

/** A SLiMS database reached directly (MySQL/MariaDB, `SELECT` only). */
export const SlimsDbSource = z.strictObject({
  kind: z.literal('db'),
  /** A host name or an IP address (no scheme, no port). */
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9._:[\]-]+$/),
  port: z.int().min(1).max(65_535),
  user: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[^\s\p{Cc}]+$/u),
  /** Never trimmed, never stored past the run (§11.1). */
  password: z.string().max(200),
  /** A MySQL database name. */
  database: z.string().regex(/^[A-Za-z0-9_$-]{1,64}$/),
  tls: z.boolean(),
});

export type SlimsDbSource = z.infer<typeof SlimsDbSource>;

/** A SLiMS SQL dump: a completed `slims.dump` upload (`.sql` or `.sql.gz`). */
export const SlimsDumpSource = z.strictObject({ kind: z.literal('dump'), uploadId: ulidField });

export type SlimsDumpSource = z.infer<typeof SlimsDumpSource>;

/** Where the migration reads SLiMS from. */
export const SlimsDbInput = z.discriminatedUnion('kind', [SlimsDbSource, SlimsDumpSource]);

export type SlimsDbInput = z.infer<typeof SlimsDbInput>;

/** `POST catalog/migrations/slims/test-connection`: a database source only. */
export const SlimsTestBody = z.strictObject({ source: SlimsDbSource });

export type SlimsTestBody = z.infer<typeof SlimsTestBody>;

/** The SLiMS generation a source looks like (detected from its tables and columns, not a version number). */
export type SlimsVersion = '9' | '8' | 'unknown';

/**
 * The answer of the connection test, always 200 (decision P2-17): the detected version, the core tables with their
 * row counts and the missing ones; or `ok: false` with `MIGRATION_SOURCE_UNREACHABLE`/`_UNSUPPORTED` and the reason.
 */
export interface SlimsTestResponse {
  ok: boolean;
  version?: SlimsVersion;
  tables?: { name: string; rows: number }[];
  missing?: string[];
  code?: ErrorCode;
  reason?: string;
}

/** How SLiMS prices are read (§11.4): whole rupiah (×100 into minor units), already minor units, or not migrated. */
export const PRICE_MODES = Object.freeze(['major', 'minor', 'skip'] as const);

export type PriceMode = (typeof PRICE_MODES)[number];

/**
 * The name of a migration source (S13): the `source` of every `migration_map` and `migration_archive` row a run
 * writes, so a second SLiMS migrated with `allowNonEmpty` under another name does not collide on legacy keys. Lower
 * case `a-z 0-9 _ -`, 1-40, never a colon: it can never pass for an import's `import:<runId>`.
 */
export const sourceNameField = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);

/**
 * `POST catalog/migrations/slims` (§11.2):
 * - Without `fromRunId`: `source` is required (`{path: 'source', code: 'required'}`), `filesUploadId` (a `slims.files`
 *   zip) optional.
 * - With `fromRunId` (S3): a succeeded dry migration run of the same user, finished less than 7 days ago and not yet
 *   adopted (else `{path: 'fromRunId', code: 'not_found'}`, the handler's). The real run adopts its NDJSON staging and
 *   `files.bin`, so `filesUploadId` and a dump `source` are refused (`exclusive`). When the dry run read a database,
 *   `source` is required again (the same host, port and database; the handler checks), and only `files.bin` is adopted.
 * - `allowNonEmpty` with `confirmLibraryName` (the library's name typed out) lets a run write into a catalog that
 *   already has records (409 `MIGRATION_TARGET_NOT_EMPTY` otherwise).
 */
export const SlimsStartBody = z
  .strictObject({
    source: SlimsDbInput.optional(),
    filesUploadId: ulidField.optional(),
    fromRunId: ulidField.optional(),
    branchId: ulidField,
    priceMode: z.enum(PRICE_MODES).default('major'),
    sourceName: sourceNameField.default('slims'),
    allowNonEmpty: z.boolean(),
    confirmLibraryName: shortText(191).optional(),
    dryRun: z.boolean(),
  })
  .check((ctx) => {
    const { source, filesUploadId, fromRunId } = ctx.value;
    if (fromRunId === undefined) {
      if (source === undefined) ctx.issues.push({ code: 'custom', path: ['source'], params: { code: 'required' }, message: 'required', input: source });
      return;
    }
    if (filesUploadId !== undefined) {
      ctx.issues.push({ code: 'custom', path: ['filesUploadId'], params: { code: 'exclusive' }, message: 'exclusive', input: filesUploadId });
    }
    if (source?.kind === 'dump') {
      ctx.issues.push({ code: 'custom', path: ['source'], params: { code: 'exclusive' }, message: 'exclusive', input: source });
    }
  });

export type SlimsStartBody = z.infer<typeof SlimsStartBody>;

/** Samples in a summary are cut to this many characters (M6); the report CSV keeps them whole. */
export const MIGRATION_SAMPLE_MAX_CHARS = 120;
/** At most this many columns keep samples in a summary (M6). */
export const MIGRATION_SAMPLE_MAX_COLUMNS = 50;
/** At most this many samples per column. */
export const MIGRATION_SAMPLES_PER_COLUMN = 5;

/** The counters of one SLiMS table (§11.6): `source = migrated + merged + Σ skipped + archived` when it reconciles. */
export interface MigrationTableCounts {
  source: number;
  migrated: number;
  /** Authority duplicates folded into another row. */
  merged: number;
  /** By reason code (`empty_key`, `orphan`, ...). */
  skipped: Record<string, number>;
  archived: number;
}

/** One row of the reconciliation; `diff` is the unexplained difference (0 to pass). */
export interface MigrationReconcileRow extends Omit<MigrationTableCounts, 'skipped'> {
  table: string;
  skipped: number;
  unread: boolean;
  diff: number;
}

/** A sample of a value a cleaning step changed (mojibake, backslashes, a bad date), cut per M6. */
export interface MigrationSample {
  /** `<table>.<column>`. */
  column: string;
  /** The fix (`mojibake`, `unescape`, `cp1252`, `php_unserialize`, `date_zero`, ...). */
  fix: string;
  before: string;
  after: string | null;
}

/** The character-set picture of one text column in the first 1 000 rows (M13). */
export interface MigrationCharsetSample {
  column: string;
  rows: number;
  ascii: number;
  utf8: number;
  cp1252: number;
  mojibake: number;
  samples: string[];
}

/**
 * The summary of a migration run (`catalog_runs.summary`, ≤ 60 000 bytes of JSON): the counters per SLiMS table, the
 * reconciliation, the text fixes per column, bounded samples (M6), the charset sample (M13), the rows per ALTIS table
 * before and after the run (M13), the random check sample (§11.6) and the report's fixed notes.
 */
export interface MigrationSummary {
  version: SlimsVersion | null;
  /** The stage the run is in, or the last one it finished. */
  stage: string | null;
  tables: Record<string, MigrationTableCounts>;
  /** The tables listed "Fase 3" and the derived ones, which are not read (§11.4). */
  unread: string[];
  reconciliation: { ok: boolean; tables: MigrationReconcileRow[] } | null;
  /** `<table>.<column>` → fix → count. */
  fixes: Record<string, Record<string, number>>;
  samples: MigrationSample[];
  charset: MigrationCharsetSample[];
  targets: { table: string; before: number; after: number }[];
  /** 20 random `biblio` → record pairs with the automatic field comparison. */
  checks: { legacyId: string; recordId: string; title: string; matches: boolean }[];
  missingFiles: number;
  nonstandardBarcodes: number;
  warnings: string[];
}
