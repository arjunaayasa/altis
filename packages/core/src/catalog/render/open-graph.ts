// OpenGraph of a record (spec §9.3): the `og:*` properties of the OPAC detail's <head>, and the `book:*` ones for a
// book. Pure; the page escapes the contents and adds the Twitter card (`<meta name="twitter:card">`), which falls back
// to these properties.
//
// No attachment URL fits an OpenGraph property, so none is written; the URLs written (`og:url`, `og:image`) are
// http(s), checked again here (S4).

import type { RecordData } from '@altis/shared/api/catalog/record-data';
import { bare, cutText, fullTitle, httpUrl, isbnsOf, oneLine, schemaTypeOf, yearOf, type RecordRenderOptions } from './names.js';

/** OpenGraph descriptions longer than this are cut at a word. */
const DESCRIPTION_MAX = 300;

const OG_LOCALES = Object.freeze({ id: 'id_ID', en: 'en_US' });

/** The OpenGraph properties of `d`, in order; none without a value. */
export function openGraph(d: RecordData, o: RecordRenderOptions): { property: string; content: string }[] {
  const out: { property: string; content: string }[] = [];
  const put = (property: string, content: string | null): void => {
    if (content !== null && content !== '') out.push({ property, content });
  };
  const book = schemaTypeOf(d) === 'Book';
  const title = fullTitle(d);
  const description = oneLine(d.summary) || oneLine(d.notes);

  put('og:type', book ? 'book' : 'website');
  put('og:title', title);
  put('og:description', description === '' ? null : cutText(description, DESCRIPTION_MAX));
  put('og:url', httpUrl(o.canonicalUrl));
  put('og:locale', o.locale === 'en' ? OG_LOCALES.en : OG_LOCALES.id);
  put('og:locale:alternate', o.locale === 'en' ? OG_LOCALES.id : OG_LOCALES.en);
  const image = httpUrl(o.coverUrl);
  if (image !== null) {
    put('og:image', image);
    put('og:image:alt', title);
  }
  if (book) {
    put('book:isbn', isbnsOf(d)[0]?.key ?? null);
    put('book:release_date', yearOf(d));
    for (const s of d.subjects) put('book:tag', bare(s.term));
  }
  return out;
}
