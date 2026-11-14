import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas, notices: what tables.test.ts expects of the table of migration 0046 (the e-mails the library owes members),
// written out by hand, independently of TABLE_CLASSES/TABLE_COLUMNS/TABLE_KEYS, in the notations of tables.test.ts.
// Kept in its own module so that tables.test.ts only spreads it in.

/** The tables of 0046. */
export type NoticesTableName = 'notices';

/** Every table of 0046 is class data. */
export const NOTICES_CLASSES: Record<NoticesTableName, 'data'> = { notices: 'data' };

/** Which migration creates which tables. */
export const NOTICES_TABLES_BY_MIGRATION: Record<string, NoticesTableName[]> = { '0046_notices': ['notices'] };

export const NOTICES_PRIMARY_KEYS: Record<NoticesTableName, string[]> = { notices: ['id'] };

export interface NoticesIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of 0046. */
export const NOTICES_INDEXES: NoticesIndexFacts[] = [
  { table: 'notices', name: 'ix_notices_member_id_created_at', unique: false, columns: ['member_id', 'created_at'] },
  { table: 'notices', name: 'ix_notices_status_created_at', unique: false, columns: ['status', 'created_at'] },
  { table: 'notices', name: 'uq_notices_ref_key', unique: true, columns: ['ref_key'] },
];

/** The unique indexes above as `table(columns)`. */
export const NOTICES_UNIQUE = NOTICES_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

/** No foreign key: a notice names its member, loans and hold by id only. */
export const NOTICES_FOREIGN_KEYS: { table: string; column: string; refTable: string; refColumn: string; onDelete: string }[] = [];

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const NOTICES_COLUMNS: Record<NoticesTableName, Record<string, string>> = {
  notices: {
    id: 'char(26)',
    member_id: 'char(26)',
    kind: 'varchar(16)',
    ref_key: 'varchar(191)',
    channel: 'varchar(16)',
    status: 'varchar(16)',
    reason: 'varchar(32) null',
    loan_ids: 'text null',
    hold_id: 'char(26) null',
    attempts: 'smallint default',
    job_id: 'char(26) null',
    claimed_at: 'bigint null',
    created_at: 'bigint',
    sent_at: 'bigint null',
  },
};

/** The database default of every column the `DB` type marks `Generated`. */
export const NOTICES_DEFAULTS = { notices: { attempts: 0 } } as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
const LATER_MS = EPOCH_MS + 86_400_000;

/**
 * Full rows of the table of 0046, typed by `DB` (tsc checks that every column is written), for the round trip of
 * tables.test.ts. Row B sets every nullable column to null. The ids are new ULIDs unless `newId` gives them.
 */
export function noticesSampleRows(o: { newId?: () => string } = {}): { [T in NoticesTableName]: Selectable<DB[T]>[] } {
  const nextId = o.newId ?? newId;
  const memberA = nextId();
  const memberB = nextId();
  const loan = nextId();
  return {
    notices: [
      {
        id: nextId(),
        member_id: memberA,
        kind: 'overdue',
        ref_key: `overdue:${memberA}:2026-01-02`,
        channel: 'email',
        status: 'sent',
        reason: 'smtp_not_configured',
        loan_ids: JSON.stringify([loan]),
        hold_id: nextId(),
        attempts: 5,
        job_id: nextId(),
        claimed_at: EPOCH_MS,
        created_at: EPOCH_MS,
        sent_at: LATER_MS,
      },
      {
        id: nextId(),
        member_id: memberB,
        kind: 'hold_ready',
        ref_key: `hold_ready:${memberB}:${LATER_MS}`,
        channel: 'email',
        status: 'queued',
        reason: null,
        loan_ids: null,
        hold_id: null,
        attempts: 0,
        job_id: null,
        claimed_at: null,
        created_at: LATER_MS,
        sent_at: null,
      },
    ],
  };
}
