// Record URLs (spec §9.1): `/katalog/<id>/<slug>`. The id decides; the slug is decoration that search engines and
// visitors read, so a stale or changed slug only redirects. Pure; no database.

import { foldForKey } from './title-key.js';

const SLUG_MAX = 80;
const SLUG_EMPTY = 'judul';

/**
 * The slug of a title: folded like the title key (diacritics stripped, lower case), every run of characters other than
 * `a-z0-9` turned into one hyphen, at most 80 characters, no hyphen at either end; `'judul'` when nothing is left
 * (an empty title, or one in a script without an ASCII form).
 */
export function recordSlug(title: string): string {
  const slug = foldForKey(title)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const cut = slug.length > SLUG_MAX ? slug.slice(0, SLUG_MAX).replace(/-$/, '') : slug;
  return cut === '' ? SLUG_EMPTY : cut;
}

/** The OPAC path of a record: `/katalog/<id>/<slug>` (path only; absolute URLs come from `config.baseUrl`). */
export function recordUrlPath(id: string, title: string): string {
  return `/katalog/${encodeURIComponent(id)}/${recordSlug(title)}`;
}
