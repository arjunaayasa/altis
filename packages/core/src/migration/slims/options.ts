import { ulidField } from '@altis/shared/api/common';
import { PRICE_MODES, SlimsDbSource, SlimsPeopleOptions, sourceNameField } from '@altis/shared/api/catalog/migration';
import { z } from 'zod';
import type { SlimsPeopleRunOptions, SlimsRunOptions } from './stage.js';

// The options of a SLiMS migration run as `catalog_runs.options` keeps them (Phase 2 spec §11.1–§11.2; plan Task 23):
// what the wizard or the CLI chose, where the job finds its input, and the S3 links between a dry run and the real run
// that took its work over. Never a secret: the database password lives only in the job's sealed `secret_param`.
//
// - `dumpStagingId`, `filesStagingId`: a folder `tmp/<id>/` whose `upload.bin` is the dump or the files archive (a
//   staged upload the start route took, or the operator's file the CLI copied there). The job's first slice moves it
//   into the run's work folder (`dump.bin`, `files.bin`), and does it again after a crash.
// - `filesDir`: the CLI's `--files-dir`, the real path of a SLiMS folder on this machine (never from the API).
// - `adoptedFrom`: the dry run whose work folder this run takes over (S3), renamed after the start's COMMIT and again
//   by the first slice when that was lost. `adoptedBy` is written on the dry run itself, in the start's transaction,
//   so a dry run is adopted once.
// - `catalogMode`, `skipCatalog`: the catalogue re-sync (`sync` also rewrites the mapped rows no one edited in ALTIS)
//   and the skip of the catalogue stages. Both are optional, so the stored options of an older run still parse
//   (`append` and `false`).
// - `people`: the member, visit and circulation options (optional as a whole and field by field, for the same reason).

/** The longest `filesDir` (a real path typed at the CLI). */
export const SLIMS_FILES_DIR_MAX = 1024;

/** The database of a run's source, without its password. */
export const SlimsDbTarget = SlimsDbSource.omit({ kind: true, password: true });

export type SlimsDbTarget = z.infer<typeof SlimsDbTarget>;

/** `catalog_runs.options` of a migration run. */
export const slimsRunSettings = z.strictObject({
  sourceKind: z.enum(['db', 'dump']),
  db: SlimsDbTarget.nullable(),
  branchId: ulidField,
  priceMode: z.enum(PRICE_MODES),
  sourceName: sourceNameField,
  allowNonEmpty: z.boolean(),
  dumpStagingId: ulidField.nullable(),
  files: z.enum(['zip', 'dir']).nullable(),
  filesStagingId: ulidField.nullable(),
  filesDir: z.string().min(1).max(SLIMS_FILES_DIR_MAX).nullable(),
  adoptedFrom: ulidField.nullable(),
  adoptedBy: ulidField.optional(),
  // ---- Komunitas K1 (catalogue re-sync) ----
  catalogMode: z.enum(['append', 'sync']).optional(),
  skipCatalog: z.boolean().optional(),
  // ---- Komunitas (SLiMS members and circulation) ----
  people: SlimsPeopleOptions.optional(),
});

export type SlimsRunSettings = z.infer<typeof slimsRunSettings>;

/**
 * The stored options `json` of a migration run, checked.
 *
 * @throws TypeError when they are not the options of a migration run
 */
export function parseSlimsRunSettings(json: string): SlimsRunSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new TypeError('catalog_runs.options of a migration run is not JSON');
  }
  const parsed = slimsRunSettings.safeParse(raw);
  if (!parsed.success) throw new TypeError('catalog_runs.options is not the options of a migration run');
  return parsed.data;
}

/** What the stages get of the settings (stage.ts's SlimsRunOptions). */
export function stageOptions(s: SlimsRunSettings): SlimsRunOptions {
  return {
    branchId: s.branchId,
    priceMode: s.priceMode,
    sourceName: s.sourceName,
    allowNonEmpty: s.allowNonEmpty,
    catalogMode: s.catalogMode ?? 'append',
    skipCatalog: s.skipCatalog ?? false,
    people: peopleOptions(s.people),
  };
}

// ---- Komunitas (SLiMS members and circulation) ----

/** The member, visit and circulation options with every default filled in (stage.ts's SlimsPeopleRunOptions). */
export function peopleOptions(p: SlimsRunSettings['people']): SlimsPeopleRunOptions {
  return {
    membersMode: p?.membersMode ?? 'append',
    visitsBefore: p?.visitsBefore ?? 'auto',
    unknownMemberGroup: p?.unknownMemberGroup ?? null,
    circulationMode: p?.circulationMode ?? 'append',
    fineMode: p?.fineMode ?? 'major',
    fineOutlierMajor: p?.fineOutlierMajor ?? 100_000,
    migrateGender: p?.migrateGender ?? false,
    defaultMemberTypeId: p?.defaultMemberTypeId ?? null,
    memberTypeGroups: { ...(p?.memberTypeGroups ?? {}) },
    staffUsers: p?.staffUsers ?? true,
    typeLimitAsTotal: p?.typeLimitAsTotal ?? false,
  };
}
