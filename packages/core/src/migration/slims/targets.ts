import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';

// The ALTIS tables a SLiMS migration run counts before and after it (the report's "rows in the ALTIS tables"): the
// analyze stage counts them first, the run's end again, and so does the end of a run its job left (ending.ts).

/** The rows per target table counted before and after the run. */
export const SLIMS_TARGET_TABLES = Object.freeze([
  'records',
  'items',
  'agents',
  'subjects',
  'publishers',
  'attachments',
  'pages',
  'migration_map',
  'migration_archive',
] as const);

export type SlimsTargetTable = (typeof SLIMS_TARGET_TABLES)[number];

type Db = Kysely<DB> | Transaction<DB>;

async function rowCount(db: Db, table: SlimsTargetTable): Promise<number> {
  const row = await db
    .selectFrom(table as 'records')
    .select((eb) => eb.fn.countAll<number | string | bigint>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** The rows of every target table. */
export async function slimsTargetCounts(db: Db): Promise<Record<SlimsTargetTable, number>> {
  const out = {} as Record<SlimsTargetTable, number>;
  for (const t of SLIMS_TARGET_TABLES) out[t] = await rowCount(db, t);
  return out;
}
