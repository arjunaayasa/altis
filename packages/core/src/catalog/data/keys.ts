import { normalizeKey } from '@altis/shared';

// The text keys of the catalog's authorities and masters (Phase 2 spec §2.1): `*_key = normalizeKey()` (NFKC, trim,
// spaces collapsed, upper case), cut to the 191 code points of a key191() column. A cut never leaves a trailing
// blank (R24: MySQL/MariaDB ignore one in comparisons and unique keys, PostgreSQL and SQLite do not). The writers
// enforce narrower widths where the spec names one; these only keep a key within its column.

/** The most code points a key191() column holds. */
export const CATALOG_KEY_MAX = 191;

/** `key` cut to {@link CATALOG_KEY_MAX} code points, without a trailing blank. */
function fitKey(key: string): string {
  // Code points, as the column counts them; a key of at most CATALOG_KEY_MAX UTF-16 units always fits.
  if (key.length <= CATALOG_KEY_MAX) return key;
  const points = Array.from(key);
  if (points.length <= CATALOG_KEY_MAX) return key;
  return points.slice(0, CATALOG_KEY_MAX).join('').trimEnd();
}

/**
 * The key of an agent (§2.2 `agents.name_key`): its name and, when known, its dates (`Toer, Pramoedya Ananta` +
 * `1925-2006` → `TOER, PRAMOEDYA ANANTA 1925-2006`), so that two people of the same name are told apart by their dates.
 */
export function agentNameKey(name: string, dates?: string | null): string {
  return fitKey(normalizeKey(name + (dates ? ` ${dates}` : '')));
}

/** The key of a subject term (`subjects.term_key`, unique per type). */
export function subjectTermKey(term: string): string {
  return fitKey(normalizeKey(term));
}

/** The key of a publisher (`publishers.name_key`). */
export function publisherNameKey(name: string): string {
  return fitKey(normalizeKey(name));
}

/** The key of a master's or a location's code (`code_key`). */
export function codeKey(display: string): string {
  return fitKey(normalizeKey(display));
}
