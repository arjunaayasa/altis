/**
 * The SLiMS migration API vocabulary (Phase 2 spec §11, §12.2, §12.3; plan Tasks 23, 30, 37, 38). Super admin only
 * (`catalog.migration.run`) with reauth; the bodies carry a database password, so both routes are `idempotency: none`
 * and the password lives only in the job's sealed secret until the run ends.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/migration`.
 */
import { z } from 'zod';
import { ACCRED_GROUPS } from '../../accreditation-vocab.js';
import type { ErrorCode } from '../../errors.js';
import { ulidField } from '../common.js';
import { dateField, shortText } from './common.js';

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

// ---- Komunitas (SLiMS members and circulation) ----

/** `append`: new members only; `update`: also re-sync mapped members field by field (fields edited in ALTIS kept). */
export const MEMBERS_MODES = Object.freeze(['append', 'update'] as const);
export type MembersMode = (typeof MEMBERS_MODES)[number];

/** `append`: new loans, holds and charges only; `replace`: the migrated ones are removed and imported again (cut-over). */
export const CIRCULATION_MODES = Object.freeze(['append', 'replace'] as const);
export type CirculationMode = (typeof CIRCULATION_MODES)[number];

/** How SLiMS fines are read: whole rupiah (×100), already minor units, or not migrated. */
export const FINE_MODES = Object.freeze(['major', 'minor', 'skip'] as const);
export type FineMode = (typeof FINE_MODES)[number];

/** A SLiMS member type id as the wizard's group map keys it (digits). */
const slimsTypeKey = z.string().regex(/^[0-9]{1,11}$/);

/**
 * The options of the member and circulation stages, all optional so that an older run's options still parse:
 * `visitsBefore` a date or `auto` (the first visit ALTIS recorded itself in the target branch); `memberTypeGroups`
 * maps a SLiMS member type id to its accreditation group (the wizard guesses from the name and lets the admin edit);
 * `unknownMemberGroup` is the group of visits and loans of SLiMS members who are gone; `typeLimitAsTotal` also takes
 * a SLiMS type's loan limit as the ALTIS type's total limit (otherwise it only limits the type's fallback rule).
 */
export const SlimsPeopleOptions = z.strictObject({
  membersMode: z.enum(MEMBERS_MODES).optional(),
  visitsBefore: z.union([z.literal('auto'), dateField]).optional(),
  unknownMemberGroup: z.enum(ACCRED_GROUPS).nullable().optional(),
  circulationMode: z.enum(CIRCULATION_MODES).optional(),
  fineMode: z.enum(FINE_MODES).optional(),
  fineOutlierMajor: z.int().min(1).max(1_000_000_000).optional(),
  migrateGender: z.boolean().optional(),
  defaultMemberTypeId: ulidField.nullable().optional(),
  memberTypeGroups: z.record(slimsTypeKey, z.enum(ACCRED_GROUPS)).optional(),
  staffUsers: z.boolean().optional(),
  typeLimitAsTotal: z.boolean().optional(),
});

export type SlimsPeopleOptions = z.infer<typeof SlimsPeopleOptions>;

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
    // ---- Komunitas K1 (catalogue re-sync) ----
    /** `append` (when absent): new rows only; `sync`: also rewrite the mapped rows no one edited in ALTIS. */
    catalogMode: z.enum(['append', 'sync']).optional(),
    /** Skip the catalogue stages; accepted only after a sync dry run (`fromRunId`) found nothing to change. */
    skipCatalog: z.boolean().optional(),
    // ---- Komunitas (SLiMS members and circulation) ----
    /** The member, visit and circulation options (each one's default when absent). */
    people: SlimsPeopleOptions.optional(),
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
  // ---- Komunitas K1 (catalogue re-sync) ----
  /** Why an unread table is not read: a later module's table, or a derived one (absent in older summaries). */
  unreadKind?: 'phase3' | 'derived';
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
  // ---- Komunitas K1 (catalogue re-sync) ----
  /** A sync dry run: the source records and copies that are new, changed or gone (absent in other runs). */
  catalogChanges?: number;
  // ---- Komunitas (SLiMS members and circulation) ----
  /** SLiMS member numbers that collide once normalised (`b 001` and `B001`): a real run is refused while any is left. */
  memberNoCollisions?: number;
  /** The SLiMS member types with the accreditation group the run used (or guessed), for the wizard's group step. */
  memberTypes?: MigrationMemberType[];
  /** "Cocokkan dengan SLiMS": each number of the source against ALTIS after the run. */
  matches?: MigrationMatchRow[];
  /** A dry run's circulation lists to check before the real run (absent in a real run). */
  dryLists?: MigrationDryList[];
}

/** A SLiMS member type as a run saw it. */
export interface MigrationMemberType {
  id: string;
  name: string;
  members: number;
  group: (typeof ACCRED_GROUPS)[number];
}

/** The numbers the cut-over checks compare (the source's against ALTIS's). */
export const MIGRATION_MATCH_KEYS = Object.freeze([
  'open_loans',
  'items_on_loan',
  'open_loans_item_missing',
  'overdue_loans',
  'unpaid_fines_minor',
  'active_members',
  'expired_members',
  'holds',
  'visits_month',
] as const);
export type MigrationMatchKey = (typeof MIGRATION_MATCH_KEYS)[number];

/**
 * One row of "Cocokkan dengan SLiMS": `scope` narrows it (a member type id, a month `YYYY-MM`, or '' for the whole);
 * `explained` counts the difference a report row of the run explains (skipped rows the report lists); `ok` when the
 * rest is 0 (for `open_loans_item_missing`, when ALTIS's number is 0).
 */
export interface MigrationMatchRow {
  key: MigrationMatchKey;
  scope: string;
  source: number;
  altis: number;
  explained: number;
  ok: boolean;
}

/**
 * The lists a dry run of the circulation stage gives the librarian to check, each with its count and a few samples:
 * open loans whose due date or fine ALTIS's rules would make differ (`loan_terms_differ`), the member types whose
 * effective loan limit changes (`type_limit_changes`), the members whose open loans would pass a rule's limit in ALTIS
 * (`members_over_limit`), the "every" rules of a member type ALTIS leaves unused (`all_rule_unused`), and the open loans
 * whose copy will not be in ALTIS (`open_loan_item_missing`).
 */
export const MIGRATION_DRY_LIST_KEYS = Object.freeze([
  'loan_terms_differ',
  'type_limit_changes',
  'members_over_limit',
  'all_rule_unused',
  'open_loan_item_missing',
] as const);
export type MigrationDryListKey = (typeof MIGRATION_DRY_LIST_KEYS)[number];
/** At most this many samples per dry-run list. */
export const MIGRATION_DRY_LIST_SAMPLES = 20;

/**
 * One dry-run list: how many rows it holds and at most {@link MIGRATION_DRY_LIST_SAMPLES} samples, which name SLiMS
 * member numbers, item codes and rule or type ids only (never a name).
 */
export interface MigrationDryList {
  key: MigrationDryListKey;
  count: number;
  samples: string[];
}

/** The cut-over checklist of the Migrasi SLiMS screen (`GET catalog/migrations/slims/cutover`). */
export interface SlimsCutoverView {
  /** The last real run that read the circulation tables, or null: nothing to check yet. */
  runId: string | null;
  finishedAt: number | null;
  /** Active staff with a password of their own and a role that may lend at the desk (migrated accounts start disabled). */
  deskStaff: number;
  /** The rooms SLiMS recorded visits in, and how many of them have an activated guestbook station. */
  rooms: number;
  roomsWithStation: number;
  /** When the reprint list of cards and labels was opened from the checklist (epoch ms), or null. */
  reprintOpenedAt: number | null;
  /** The run's matches all hold (0 unexplained differences, no open loan whose item ALTIS lacks). */
  reconciled: boolean;
  /** Whether this release has stocktaking (without it: finish a scheduled one in SLiMS before moving). */
  stocktakeAvailable: boolean;
  /** Every required item holds: "Mulai melayani" may be pressed. */
  ready: boolean;
  /** When the library started to serve in ALTIS (epoch ms), or null. */
  servingSince: number | null;
  /** ALTIS already has circulation of its own: a `replace` run is refused (MIGRATION_CIRCULATION_LIVE). */
  circulationLive: boolean;
}

/** `POST catalog/migrations/slims/cutover/steps`: an item of the checklist the admin marks done. */
export const SlimsCutoverStepBody = z.strictObject({ step: z.enum(['reprint_opened', 'serve']) });

export type SlimsCutoverStepBody = z.infer<typeof SlimsCutoverStepBody>;
