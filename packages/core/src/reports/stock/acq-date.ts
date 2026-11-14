import { isCalendarDate, localDate } from '@altis/shared';

// The acquisition date of a copy: the first known of a chain of dates. The time a migration ran is never an
// acquisition date, so a migrated copy whose only clue is the migration's own clock stays undated: an undated copy is
// in the stock at every date and never counts as an addition.

/** Where an acquisition date comes from. */
export type AcqBasis = 'received' | 'input_on' | 'record_created' | 'item_created';

/** What the chain reads of one copy. */
export interface AcqInput {
  /** `items.received_date`: used only when it is a real calendar day (a source's `0000-00-00` is not). */
  receivedDate: string | null;
  /** `items.input_on`: the date the copy was entered in the source system (written by a migration only). */
  inputOn: string | null;
  /** The type of the copy's earliest history row; null when it has none or another type. */
  firstEventType: 'created' | 'imported' | 'migrated' | null;
  /** `records.created_at` of the copy's record; null when unknown. */
  recordCreatedAt: number | null;
  /** True when that time is the clock of the migration run that created the record, not a date of the source. */
  recordCreatedInMigrationSpan: boolean;
  /** `items.created_at`. */
  itemCreatedAt: number;
  /** The library's time zone (local dates of instants). */
  tz: string;
}

const UNDATED = Object.freeze({ date: null, basis: null });

/**
 * The acquisition date of a copy and its basis, the first that applies of:
 * 1. its receiving date;
 * 2. the date it was entered in the source system;
 * 3. a migrated copy: the local date of its record's creation, unless that is the migration's own time (unknown);
 * 4. a copy made here: the local date of its own creation;
 * 5. otherwise (an imported copy, a copy without history) unknown.
 *
 * A migrated copy never falls through to step 4: its own creation time is the migration's.
 */
export function acqDateOf(i: AcqInput): { date: string | null; basis: AcqBasis | null } {
  if (i.receivedDate !== null && isCalendarDate(i.receivedDate)) return { date: i.receivedDate, basis: 'received' };
  if (i.inputOn !== null && isCalendarDate(i.inputOn)) return { date: i.inputOn, basis: 'input_on' };
  if (i.firstEventType === 'migrated') {
    if (i.recordCreatedAt !== null && !i.recordCreatedInMigrationSpan) return { date: localDate(i.tz, i.recordCreatedAt), basis: 'record_created' };
    return { ...UNDATED };
  }
  if (i.firstEventType === 'created') return { date: localDate(i.tz, i.itemCreatedAt), basis: 'item_created' };
  return { ...UNDATED };
}
