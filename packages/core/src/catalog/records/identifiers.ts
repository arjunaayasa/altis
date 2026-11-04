import { normalizeKey, type IdentifierType } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import type { IdentifierInput } from '@altis/shared/api/catalog/record-data';
import { normalizeDoi, parseIsbn, parseIssn } from '../lib/identifiers.js';

// A record's identifiers (Phase 2 spec §2.2 `record_identifiers`, §3.2): each one as written (`value_display`) and
// its key (`value_key`), which the duplicate check, the import match and the search compare.
//
// - ISBN-10 and ISBN-13 key to 13 digits; ISSN to 8 characters (upper-case X); DOI to its lower-case name without a
//   resolver prefix; `control` (`<003>:<001>` of an import) as written; `other` by normalizeKey.
// - A wrong check digit, or an ISBN/ISSN that does not even have the shape of one, is stored all the same with
//   `is_valid = 0` and the warning `{path: 'identifiers.<i>.value', code: 'isbn_invalid' | 'issn_invalid'}` (never a
//   refusal: imports carry such values). A DOI that does not parse keeps its lower-cased text as the key, `is_valid 0`.
// - Two entries with the same `(type, value_key)` are one identifier (the table's unique key): the first is kept.

/** `record_identifiers.value_key` is a key191() column. */
const KEY_MAX = 191;

/** One row to store, without its record id. */
export interface IdentifierRow {
  type: IdentifierType;
  value_display: string;
  value_key: string;
  qualifier: string | null;
  is_valid: 0 | 1;
  sort_order: number;
}

/** `s` cut to {@link KEY_MAX} code points, without a trailing blank. */
function fit(s: string): string {
  const points = Array.from(s);
  return points.length <= KEY_MAX ? s : points.slice(0, KEY_MAX).join('').trimEnd();
}

/** What an ISBN or ISSN that does not parse keys to: its characters without separators, upper case. */
function looseKey(value: string): string {
  return fit(value.normalize('NFKC').replace(/[\s\-\u{2010}-\u{2015}\u{2212}]/gu, '').toUpperCase());
}

/** The key, display form and validity of one identifier. */
export function identifierKey(type: IdentifierType, value: string): { key: string; display: string; valid: boolean } {
  const trimmed = value.trim();
  switch (type) {
    case 'isbn': {
      const p = parseIsbn(trimmed);
      return p === null ? { key: looseKey(trimmed), display: trimmed, valid: false } : { key: p.key, display: p.display, valid: p.valid };
    }
    case 'issn': {
      const p = parseIssn(trimmed);
      return p === null ? { key: looseKey(trimmed), display: trimmed, valid: false } : { key: p.key, display: p.display, valid: p.valid };
    }
    case 'doi': {
      const key = normalizeDoi(trimmed);
      return key === null ? { key: fit(trimmed.toLowerCase()), display: trimmed, valid: false } : { key, display: trimmed, valid: true };
    }
    case 'control':
      return { key: fit(trimmed), display: trimmed, valid: true };
    case 'other':
      return { key: fit(normalizeKey(trimmed)), display: trimmed, valid: true };
  }
}

/**
 * The rows of `inputs` (in order, duplicates of an earlier `(type, value_key)` dropped) and the warnings of the ISBNs
 * and ISSNs stored as not valid, at their index in `inputs`.
 */
export function identifierRows(inputs: readonly IdentifierInput[]): { rows: IdentifierRow[]; warnings: FieldWarning[] } {
  const rows: IdentifierRow[] = [];
  const warnings: FieldWarning[] = [];
  const seen = new Set<string>();
  inputs.forEach((input, i) => {
    const { key, display, valid } = identifierKey(input.type, input.value);
    if (!valid && (input.type === 'isbn' || input.type === 'issn')) {
      warnings.push({ path: `identifiers.${i}.value`, code: input.type === 'isbn' ? 'isbn_invalid' : 'issn_invalid' });
    }
    const unique = `${input.type}\u0000${key}`;
    if (key === '' || seen.has(unique)) return;
    seen.add(unique);
    const qualifier = input.qualifier?.trim() ?? '';
    rows.push({
      type: input.type,
      value_display: display,
      value_key: key,
      qualifier: qualifier === '' ? null : qualifier,
      is_valid: valid ? 1 : 0,
      sort_order: rows.length,
    });
  });
  return { rows, warnings };
}
