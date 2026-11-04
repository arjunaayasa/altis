// The in-memory MARC 21 record shared by the readers, the writers and the mapping (Phase 2 spec §5.1, plan Task 6).
// Text is Unicode (a MARC-8 record is decoded on reading); the leader is kept as read. Pure; no I/O.

/** A control field (tags 001-009, `00X`): no indicators, no subfields. */
export interface MarcControlField {
  tag: string;
  value: string;
}

/** A data field: two one-character indicators and its subfields in order, each `[code, value]`. */
export interface MarcDataField {
  tag: string;
  ind1: string;
  ind2: string;
  subfields: [code: string, value: string][];
}

/** A record: its 24-character leader and its fields in record order. */
export interface MarcRecord {
  leader: string;
  fields: (MarcControlField | MarcDataField)[];
}

/** What a record reader flags on a record it could still read. */
export type MarcReadWarning = 'leader_length' | 'marc8_replaced' | 'missing_terminator';

/**
 * One record of a reader (`index` counts every record of this reader from 0, failed ones included):
 * - `ok`: the record, with its warnings (`leader_length`: the leader's record length or base address disagrees with
 *   the bytes; `marc8_replaced`: MARC-8 characters outside ASCII and ANSEL became `?`; `missing_terminator`: a field
 *   or the record had no terminator);
 * - not `ok`: why the record was skipped (`directory`: its structure is broken (the ISO 2709 directory, or in MARCXML a
 *   bad tag, indicator or subfield code); `truncated`: no record terminator within 100 000 bytes; `encoding`: bytes
 *   that are not valid in the record's encoding).
 */
export type MarcReadResult =
  | { ok: true; record: MarcRecord; index: number; warnings: MarcReadWarning[] }
  | { ok: false; index: number; error: 'directory' | 'truncated' | 'encoding' };

/** ISO 2709 cannot hold a record longer than this many bytes (five digits of record length). */
export const MARC_RECORD_MAX = 99_999;

/** A record that does not fit ISO 2709: above 99 999 bytes, or a field above 9 999 bytes. */
export class MarcTooLongError extends Error {
  /** The length the record (or the field) would have had, in bytes. */
  readonly length: number;

  constructor(length: number, what: 'record' | 'field' = 'record') {
    super(`MARC ${what} too long for ISO 2709 (${length} bytes)`);
    this.name = 'MarcTooLongError';
    this.length = length;
  }
}

/** The MARCXML namespace (MARC 21 slim). */
export const MARCXML_NS = 'http://www.loc.gov/MARC21/slim';

/** A tag as ISO 2709 and MARCXML allow it: three ASCII letters or digits. */
export const MARC_TAG_RE = /^[0-9A-Za-z]{3}$/;

/** Whether `tag` names a control field (`00X`). */
export function isControlTag(tag: string): boolean {
  return tag.length === 3 && tag.startsWith('00');
}

/** Whether `f` is a control field. */
export function isControlField(f: MarcControlField | MarcDataField): f is MarcControlField {
  return !('subfields' in f);
}

/** One printable ASCII character, else a space: what an indicator may hold. */
export function marcIndicator(s: string | undefined): string {
  return s !== undefined && s.length === 1 && s >= '\x20' && s <= '\x7E' ? s : ' ';
}

/** A leader of exactly 24 printable ASCII characters: anything else becomes a space, a short one is padded. */
export function marcLeader24(leader: string): string {
  let out = '';
  for (let i = 0; i < 24; i++) {
    const ch = leader[i];
    out += ch !== undefined && ch >= '\x20' && ch <= '\x7E' ? ch : ' ';
  }
  return out;
}

/** `leader` with position 09 set to `a` (Unicode), after {@link marcLeader24}. */
export function unicodeLeader(leader: string): string {
  const l = marcLeader24(leader);
  return `${l.slice(0, 9)}a${l.slice(10)}`;
}
