import { ACCRED_GROUPS } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import { dateField } from '@altis/shared/api/catalog/common';
import { z } from 'zod';

// The options of a SLiMS usage import as its `catalog_runs` row keeps them (`options`): where the counts come from
// (a database or a dump), the period it was started from, the day the library moved to ALTIS, the member type mapping
// it was given, the group of members SLiMS no longer has, and the repeat-visit window in force at its start. Never a
// secret: the database password and the hashing key live only in the job's sealed `secret_param`. The period page and
// the usage grid read the last import's options with this schema; the import writes them.

/** The largest repeat-visit window, in minutes (0 turns the rule off). */
const DEDUPE_MINUTES_MAX = 720;

/** `catalog_runs.options` of a `slims_usage` run. */
export const slimsUsageRunSettings = z.strictObject({
  sourceKind: z.enum(['db', 'dump']),
  periodId: ulidField,
  cutoverOn: dateField.nullable(),
  memberTypeGroups: z.record(z.string().max(36), z.enum(ACCRED_GROUPS).nullable()).optional(),
  unknownMemberGroup: z.enum(ACCRED_GROUPS).nullable().optional(),
  dedupeMinutes: z.number().int().min(0).max(DEDUPE_MINUTES_MAX),
});

export type SlimsUsageRunSettings = z.infer<typeof slimsUsageRunSettings>;
