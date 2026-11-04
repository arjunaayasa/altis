import type { DbHandle } from '@altis/db';
import { legacyRecordPath, legacySource } from './queries.js';

// Old SLiMS links (Phase 2 Task 21; spec §9.9, S13): a library that migrated keeps the links others made to its old
// OPAC. `GET /index.php?p=show_detail&id=N` goes to the record SLiMS biblio N became (migration_map of the latest real
// migration's source), `?keywords=x` to the search, anything else to the home page; always a 301 to a local path
// (redirect301 refuses any other). Old OAI identifiers (`oai:<host>:slims-N`) are not served: harvesters start again.

/** What an `/index.php` request asks for. */
export type LegacyRequest = { kind: 'record'; legacyKey: string } | { kind: 'search'; q: string } | { kind: 'home' };

const HOME: LegacyRequest = Object.freeze({ kind: 'home' });

/** A SLiMS biblio id: digits only (at most 19, a BIGINT), not zero. */
const LEGACY_ID = /^\d{1,19}$/;

/** A search text keeps at most this many characters (the search page bounds its own query too). */
const KEYWORDS_MAX = 500;

/** What a search text never holds: control characters, lone surrogates, line and paragraph separators. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * What the `/index.php` request whose query parameters `get` reads asks for (the first value of each name):
 * `p=show_detail` with a numeric `id` (leading zeros dropped, as SLiMS's integer ids have none) is a record; a
 * non-blank `keywords` is a search (control characters turned into spaces, blanks collapsed, at most 500 characters);
 * anything else, an invalid id included, is the home page.
 */
export function legacyRequest(get: (name: string) => string | undefined): LegacyRequest {
  if (get('p') === 'show_detail') {
    const id = get('id');
    if (id === undefined || !LEGACY_ID.test(id)) return HOME;
    const key = id.replace(/^0+/, '');
    return key === '' ? HOME : { kind: 'record', legacyKey: key };
  }
  const keywords = get('keywords');
  if (keywords === undefined) return HOME;
  const q = Array.from(keywords.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, KEYWORDS_MAX)
    .join('')
    .trim();
  return q === '' ? HOME : { kind: 'search', q };
}

/** The search page for `q` (`/cari?q=…`, percent-encoded: always a local path of printable ASCII). */
export function searchRedirectPath(q: string): string {
  return `/cari?q=${encodeURIComponent(q.replace(UNSAFE_TEXT, ' '))}`;
}

/** The local path an `/index.php` request is sent to (see the top of this file). */
export async function legacyRedirectPath(db: DbHandle['db'], get: (name: string) => string | undefined): Promise<string> {
  const request = legacyRequest(get);
  switch (request.kind) {
    case 'record':
      return (await legacyRecordPath(db, await legacySource(db), request.legacyKey)) ?? '/';
    case 'search':
      return searchRedirectPath(request.q);
    case 'home':
      return '/';
  }
}
