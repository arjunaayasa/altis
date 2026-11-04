import type { AcqSource } from '@altis/shared';

// SLiMS item statuses and acquisition sources (Phase 2 spec §11.4 rows `mst_item_status` and `item`; plan Task 38).
// Pure; the items stage reads `mst_item_status` once and hands each item's row here.
//
// - `item_status_id` `''` or `'0'` (SLiMS's "available", stored either way) → `available`;
// - `R` → `repair`, `MIS` → `missing`, `NL` or a status row with `no_loan = 1` → `not_for_loan`;
// - any other status → `available` with the SLiMS name and code in `status_note`, and a report row (`unknown`).
// Codes compare without case and outer blanks (MySQL compares them under a case-insensitive collation).

/** The ALTIS statuses a SLiMS status becomes. */
export type SlimsItemStatus = 'available' | 'not_for_loan' | 'repair' | 'missing';

/** A row of `mst_item_status`, as the items stage reads it. */
export interface SlimsStatusRow {
  /** `item_status_name`, cleaned ('' when none). */
  name: string;
  /** `no_loan = 1`. */
  noLoan: boolean;
}

/** `status_note` holds at most this many characters. */
const NOTE_MAX = 191;

function cut(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join('').trimEnd();
}

/**
 * The ALTIS status of a SLiMS `item_status_id` (`id`, cleaned text) whose `mst_item_status` row is `row` (null: none),
 * with the note an unknown status leaves in `status_note` (`SLiMS: <name> (<code>)`, or `SLiMS: <code>`).
 */
export function slimsItemStatus(id: string, row: SlimsStatusRow | null): { status: SlimsItemStatus; note: string | null; unknown: boolean } {
  const code = id.trim();
  const upper = code.toUpperCase();
  if (upper === '' || upper === '0') return { status: 'available', note: null, unknown: false };
  if (upper === 'R') return { status: 'repair', note: null, unknown: false };
  if (upper === 'MIS') return { status: 'missing', note: null, unknown: false };
  if (upper === 'NL' || row?.noLoan === true) return { status: 'not_for_loan', note: null, unknown: false };
  const name = row?.name.trim() ?? '';
  const note = name === '' || name === code ? `SLiMS: ${code}` : `SLiMS: ${name} (${code})`;
  return { status: 'available', note: cut(note, NOTE_MAX), unknown: true };
}

/** `item.source`: 1 → `purchase`, 2 → `gift`, anything else (0, NULL, text) → `other`. */
export function slimsAcqSource(v: unknown): AcqSource {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (s === '1') return 'purchase';
  if (s === '2') return 'gift';
  return 'other';
}
