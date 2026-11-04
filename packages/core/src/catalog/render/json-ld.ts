// schema.org JSON-LD of a record (spec §9.4, D2-22). Pure: it returns the object; the OPAC page embeds it only
// through `jsonLdScript(nonce, value)` (S6), which escapes `<` and U+2028/2029.
//
// - `@type` is the material type's `schema_type`, `CreativeWork` when that is not one of §9.4's seven types.
// - Properties of one type only are written for that type: `bookEdition`, `isbn` and `numberOfPages` for a `Book`,
//   `issn` for a `Periodical` (schema.org defines them there; a validator flags them elsewhere).
// - `numberOfPages` only when the physical description parses for certain (M1): `245 hlm.`, `245 h.`, `245 p. :
//   ill.`; never `xii, 245 hlm.`.
// - `image` only with a cover; `associatedMedia` for the public http(s) links, re-checked (S4); `workExample` is not
//   used.

import type { RecordData } from '@altis/shared/api/catalog/record-data';
import {
  agentGroups,
  bare,
  directName,
  httpUrl,
  isbnsOf,
  issnsOf,
  languageCodeOf,
  multiLine,
  oneLine,
  publicLinks,
  publisherOf,
  schemaTypeOf,
  yearOf,
  type RecordRenderOptions,
  type RenderAgent,
} from './names.js';

/** §9.4 / M1: a page count stated first and for certain (`\b` after a `.` never matches before a space or the end). */
const PAGES_RE = /^\s*(\d+)\s*(hlm|halaman|h\.|p\.|pages)(?=\s|$|[,;.])/;

/** A page count above this is a typing error, not a book. */
const PAGES_MAX = 100_000;

/** MARC language codes (ISO 639-2/B, as `languages.code` stores them) whose BCP 47 tag differs from the code. */
const BCP47: Readonly<Record<string, string>> = Object.freeze({
  alb: 'sq',
  ara: 'ar',
  arm: 'hy',
  baq: 'eu',
  ben: 'bn',
  bur: 'my',
  chi: 'zh',
  cze: 'cs',
  dan: 'da',
  dut: 'nl',
  eng: 'en',
  fin: 'fi',
  fre: 'fr',
  geo: 'ka',
  ger: 'de',
  gre: 'el',
  heb: 'he',
  hin: 'hi',
  ice: 'is',
  ind: 'id',
  ita: 'it',
  jav: 'jv',
  jpn: 'ja',
  kor: 'ko',
  lat: 'la',
  mac: 'mk',
  mao: 'mi',
  may: 'ms',
  nor: 'no',
  per: 'fa',
  pol: 'pl',
  por: 'pt',
  rum: 'ro',
  rus: 'ru',
  slo: 'sk',
  spa: 'es',
  sun: 'su',
  swe: 'sv',
  tam: 'ta',
  tgl: 'tl',
  tha: 'th',
  tib: 'bo',
  tur: 'tr',
  ukr: 'uk',
  urd: 'ur',
  vie: 'vi',
  wel: 'cy',
});

/** The BCP 47 tag of a MARC language code (`ind` → `id`; a code without a two-letter form as is), or null. */
function languageTag(code: string): string | null {
  const c = code.toLowerCase();
  if (!/^[a-z]{2,3}$/.test(c)) return null;
  return Object.hasOwn(BCP47, c) ? BCP47[c]! : c;
}

/** The page count of a physical description, or null when it is not stated first and for certain. */
function numberOfPages(physicalDesc: string | undefined): number | null {
  const m = PAGES_RE.exec(physicalDesc ?? '');
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 && n <= PAGES_MAX ? n : null;
}

function agentNode(a: RenderAgent): { '@type': 'Person' | 'Organization'; name: string } {
  return { '@type': a.type === 'person' ? 'Person' : 'Organization', name: directName(a) };
}

/** One value as is, several as a list. */
function oneOrMany(values: string[]): string | string[] {
  return values.length === 1 ? values[0]! : values;
}

/** The JSON-LD object of `d` (§9.4): plain JSON values only, no property without a value. */
export function recordJsonLd(d: RecordData, o: RecordRenderOptions): Record<string, unknown> {
  const type = schemaTypeOf(d);
  const ld: Record<string, unknown> = { '@context': 'https://schema.org', '@type': type };
  const put = (name: string, value: unknown): void => {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return;
    ld[name] = value;
  };

  const canonical = httpUrl(o.canonicalUrl);
  put('@id', canonical);
  put('url', canonical);
  put('name', bare(d.title) || oneLine(d.title));
  put('alternativeHeadline', bare(d.subtitle));
  const { creators, editors, others } = agentGroups(d);
  put('author', creators.map(agentNode));
  put('contributor', [...editors, ...others].map(agentNode));
  const publisher = publisherOf(d);
  if (publisher !== '') put('publisher', { '@type': 'Organization', name: publisher });
  put('datePublished', yearOf(d));
  if (type === 'Book') {
    put('bookEdition', bare(d.edition));
    const isbns = isbnsOf(d).map((i) => i.key);
    if (isbns.length > 0) put('isbn', oneOrMany(isbns));
    put('numberOfPages', numberOfPages(d.physicalDesc));
  }
  if (type === 'Periodical') {
    const issns = issnsOf(d);
    if (issns.length > 0) put('issn', oneOrMany(issns));
  }
  put('inLanguage', languageTag(languageCodeOf(d)));
  put(
    'about',
    d.subjects.flatMap((s) => {
      const name = bare(s.term);
      return name === '' ? [] : [{ '@type': s.type === 'geographic' ? 'Place' : 'Thing', name }];
    }),
  );
  put('description', multiLine(d.summary) || multiLine(d.notes));
  put('image', httpUrl(o.coverUrl));
  put(
    'associatedMedia',
    publicLinks(d).map((l) => ({ '@type': 'MediaObject', name: l.title || l.url, url: l.url })),
  );
  return ld;
}
