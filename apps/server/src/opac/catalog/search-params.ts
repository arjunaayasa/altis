import type { CatalogSearchQuery } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { ATTACHMENT_MEDIA, isUlid, normalizeKey, type Locale } from '@altis/shared';

// The query string of the OPAC search (Phase 2 Task 33; spec §4.4–§4.6, §9.1): what `/cari` and `/cari/rss` read, and
// the links that write it back. The routes have no `query` schema (§9.1): every value is checked here by hand, and an
// invalid or unknown one is ignored, never a 4xx. What was accepted comes back as `echo` (canonical values, a fixed
// order), and every link of the page (facets, sorting, paging, the feed) is built from it by searchPath, never from
// the raw request.
//
//   q          the query text in the §4.4 syntax (control characters → spaces, ≤ 500 code points)
//   persis     `1`: the query exactly as typed (the "Cari X saja?" link of an applied correction, §4.7)
//   ruas       judul|pengarang|subjek: every word or phrase of `q` searched in that field (the syntax's `judul:`,
//              `pengarang:`, `subjek:`), only with a text; `semua` (or nothing) searches every field
//   jenis      a material type's code      bahasa   a language's code
//   koleksi    a collection type's code    cabang   a branch's code
//   lokasi     a room's id                 subjek   a subject's id        pengarang   an agent's id
//   tahun      `1990-2000` or one year     tersedia `1`                   lampiran    one of ATTACHMENT_MEDIA
//   kelas      0-9 (the `cl` facet, M4)    urut     relevansi|terbaru|judul|tahun_baru|tahun_lama|populer
//   hal        the page, from 1 (past 50 the search reports the page cap, §4.5)
//
// A parameter given twice counts once (its first value). A code is matched as its `code_key` (normalizeKey: NFKC, upper
// case) and echoed so; an id must be a ULID, and the route then checks that it names something the OPAC shows.

/** The parameters of the search, in the order every link writes them. */
export const OPAC_SEARCH_PARAMS = [
  'q',
  'persis',
  'ruas',
  'jenis',
  'bahasa',
  'koleksi',
  'cabang',
  'lokasi',
  'subjek',
  'pengarang',
  'tahun',
  'tersedia',
  'lampiran',
  'kelas',
  'urut',
  'hal',
] as const;

export type OpacSearchParam = (typeof OPAC_SEARCH_PARAMS)[number];

/** The accepted parameters, canonical (see the top of this file). */
export type OpacSearchEcho = Partial<Record<OpacSearchParam, string>>;

/** The query text is cut to this many code points (the search box's `maxlength`). */
export const OPAC_SEARCH_TEXT_MAX = 500;

/** `urut` → the search's order (§4.5). */
export const OPAC_SORTS = Object.freeze({
  relevansi: 'relevance',
  terbaru: 'newest',
  judul: 'title',
  tahun_baru: 'year_desc',
  tahun_lama: 'year_asc',
  // ---- Komunitas (OPAC home page): the popular titles first ----
  populer: 'popular',
} as const satisfies Record<string, NonNullable<CatalogSearchQuery['sort']>>);

export type OpacSort = keyof typeof OPAC_SORTS;

// ---- Komunitas (OPAC look): the field a search looks in ----
/**
 * The fields a search can be limited to (`ruas`), `semua` first (every field, the default): the fields of the query
 * syntax that search one part of a record. ISBN is no field of its own: the search recognises an ISBN or ISSN in any
 * text first.
 */
export const OPAC_SEARCH_SCOPES = Object.freeze(['semua', 'judul', 'pengarang', 'subjek'] as const);

export type OpacSearchScope = (typeof OPAC_SEARCH_SCOPES)[number];

/** A field of the query syntax already written before a word (`judul:`, `-author:`), any case. */
const FIELDED = /^-?[A-Za-z]+:/;

/**
 * `text` with every word and quoted phrase searched in the field `scope` (`rumah "ujung sawah"` → `judul:rumah
 * judul:"ujung sawah"`): a word or phrase that already names a field, the operators `ATAU`/`OR` and an unbalanced quote
 * stay as typed, an excluding `-` stays in front. The text is returned as it is for `semua`.
 */
export function scopedText(text: string, scope: OpacSearchScope): string {
  if (scope === 'semua') return text;
  const out: string[] = [];
  // A word, or a quoted phrase with the field that may stand before it; a lone quote (an unbalanced one) on its own.
  const re = /(-?)((?:[A-Za-z]+:)?"[^"]*"|[^\s"]+)|"/gu;
  for (const m of text.matchAll(re)) {
    const [whole, minus = '', term = ''] = m;
    if (whole === '"' || term === '' || FIELDED.test(whole) || (minus === '' && (term === 'ATAU' || term === 'OR'))) out.push(whole);
    else out.push(`${minus}${scope}:${term}`);
  }
  return out.join(' ');
}

/** `text` without the field `scope` written before its words: what {@link scopedText} added, as the visitor typed it. */
export function unscopedText(text: string, scope: OpacSearchScope): string {
  if (scope === 'semua') return text;
  return text.replace(new RegExp(`(^|\\s)(-?)${scope}:`, 'giu'), '$1$2');
}

/** The `code_key` → id of each master the search takes a code of. */
export interface OpacSearchLookups {
  materialTypeByCode: ReadonlyMap<string, string>;
  languageByCode: ReadonlyMap<string, string>;
  collectionTypeByCode: ReadonlyMap<string, string>;
  branchByCode: ReadonlyMap<string, string>;
}

/** What `parseOpacSearchParams` answers: the search to run (without its page size and facets) and the echo. */
export interface ParsedOpacSearch {
  query: CatalogSearchQuery & { sort: NonNullable<CatalogSearchQuery['sort']>; page: number; filters: NonNullable<CatalogSearchQuery['filters']> };
  echo: OpacSearchEcho;
}

/** Text the query never keeps: control characters (C0, DEL, C1), lone surrogates, line and paragraph separators. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu;
/** One year or a range of two (an ASCII hyphen or an en or em dash, spaces around allowed). */
const YEARS = /^(\d{1,4})(?:\s*[-\u2013\u2014]\s*(\d{1,4}))?$/;
const PAGE = /^[1-9]\d{0,5}$/;
const DIGIT = /^[0-9]$/;

/** The first value of `name`, or undefined. */
function first(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  return v === null ? undefined : v;
}

/** The query text of `raw`: see {@link UNSAFE_TEXT}, whitespace collapsed, trimmed, at most 500 code points. */
function cleanText(raw: string | undefined): string {
  if (raw === undefined) return '';
  const text = raw.replace(UNSAFE_TEXT, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= OPAC_SEARCH_TEXT_MAX ? text : chars.slice(0, OPAC_SEARCH_TEXT_MAX).join('').trimEnd();
}

/** The `code_key` of `raw` and its id in `byCode`, or null. */
function code(raw: string | undefined, byCode: ReadonlyMap<string, string>): { key: string; id: string } | null {
  if (raw === undefined) return null;
  const key = normalizeKey(raw);
  const id = key === '' ? undefined : byCode.get(key);
  return id === undefined ? null : { key, id };
}

/** `raw` when it is a ULID (as written: ids are upper case), else null. */
function ulid(raw: string | undefined): string | null {
  return raw !== undefined && isUlid(raw) ? raw : null;
}

/** The year range of `raw`, in order, or null. */
function years(raw: string | undefined): { from: number; to: number } | null {
  const m = raw === undefined ? null : YEARS.exec(raw.trim());
  if (m === null) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/**
 * The search of an OPAC request's query string (see the top of this file). Never throws.
 *
 * @param lookups the codes of the masters the search takes a code of (code_key → id)
 */
export function parseOpacSearchParams(params: URLSearchParams, lookups: OpacSearchLookups): ParsedOpacSearch {
  const echo: OpacSearchEcho = {};
  const filters: ParsedOpacSearch['query']['filters'] = {};

  const text = cleanText(first(params, 'q'));
  let scope: OpacSearchScope = 'semua';
  if (text !== '') {
    echo.q = text;
    if (first(params, 'persis') === '1') echo.persis = '1';
    const ruas = first(params, 'ruas');
    if (ruas !== undefined && ruas !== 'semua' && (OPAC_SEARCH_SCOPES as readonly string[]).includes(ruas)) {
      scope = ruas as OpacSearchScope;
      echo.ruas = scope;
    }
  }

  const codes: [OpacSearchParam, ReadonlyMap<string, string>, 'materialTypeIds' | 'languageIds' | 'collectionTypeIds' | 'branchIds'][] = [
    ['jenis', lookups.materialTypeByCode, 'materialTypeIds'],
    ['bahasa', lookups.languageByCode, 'languageIds'],
    ['koleksi', lookups.collectionTypeByCode, 'collectionTypeIds'],
    ['cabang', lookups.branchByCode, 'branchIds'],
  ];
  for (const [name, byCode, field] of codes) {
    const found = code(first(params, name), byCode);
    if (found === null) continue;
    echo[name] = found.key;
    filters[field] = [found.id];
  }

  const ids: [OpacSearchParam, 'locationIds' | 'subjectIds' | 'agentIds'][] = [
    ['lokasi', 'locationIds'],
    ['subjek', 'subjectIds'],
    ['pengarang', 'agentIds'],
  ];
  for (const [name, field] of ids) {
    const id = ulid(first(params, name));
    if (id === null) continue;
    echo[name] = id;
    filters[field] = [id];
  }

  const range = years(first(params, 'tahun'));
  if (range !== null) {
    echo.tahun = range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;
    filters.yearFrom = range.from;
    filters.yearTo = range.to;
  }

  if (first(params, 'tersedia') === '1') {
    echo.tersedia = '1';
    filters.available = true;
  }

  const media = first(params, 'lampiran')?.toLowerCase();
  if (media !== undefined && (ATTACHMENT_MEDIA as readonly string[]).includes(media)) {
    echo.lampiran = media;
    filters.attachmentKinds = [media];
  }

  const digit = first(params, 'kelas');
  if (digit !== undefined && DIGIT.test(digit)) {
    echo.kelas = digit;
    filters.classDigit = Number(digit);
  }

  // §4.5: relevance with a query text, newest without; `relevansi` without a text has nothing to rank.
  const urut = first(params, 'urut');
  let sort: NonNullable<CatalogSearchQuery['sort']> = text === '' ? 'newest' : 'relevance';
  if (urut !== undefined && Object.hasOwn(OPAC_SORTS, urut) && !(urut === 'relevansi' && text === '')) {
    echo.urut = urut;
    sort = OPAC_SORTS[urut as OpacSort];
  }

  const hal = first(params, 'hal');
  const page = hal !== undefined && PAGE.test(hal) ? Number(hal) : 1;
  if (page > 1) echo.hal = String(page);

  // The search runs the text in its field; the page shows it as typed (echo.q).
  return { query: { text: scopedText(text, scope), scope: 'opac', filters, sort, page }, echo };
}

/**
 * The link to `base` (`/cari`, `/cari/rss`) with the parameters of `echo` changed by `change` (a string sets one, null
 * removes it), in the fixed order of {@link OPAC_SEARCH_PARAMS}, then `lang` when the page keeps one. `hal` is dropped
 * unless the change sets it (a new filter or order starts at page 1), and `hal=1` is not written. A local path.
 */
export function searchPath(echo: OpacSearchEcho, change: Partial<Record<OpacSearchParam, string | null>>, lang: Locale | null, base = '/cari'): string {
  const out = new URLSearchParams();
  for (const name of OPAC_SEARCH_PARAMS) {
    const value = Object.hasOwn(change, name) ? change[name] : name === 'hal' ? undefined : echo[name];
    if (value === undefined || value === null || value === '') continue;
    if (name === 'hal' && value === '1') continue;
    out.append(name, value);
  }
  if (lang !== null) out.append('lang', lang);
  const query = out.toString();
  return query === '' ? base : `${base}?${query}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The masters a search page reads (the codes it takes, the names it shows)

type Db = DbHandle['db'];

/** One master of the search (a material type, a language, a collection type or a branch). */
export interface SearchMaster {
  id: string;
  /** Its `code_key`, as the links write it. */
  code: string;
  nameId: string;
  nameEn: string;
}

/** Every master the search page shows or takes a code of, archived ones included (a facet always has its label). */
export interface SearchMasters {
  materialTypes: readonly SearchMaster[];
  languages: readonly SearchMaster[];
  collectionTypes: readonly SearchMaster[];
  branches: readonly SearchMaster[];
}

/** The masters (four small tables; read per request, so an edit shows at once in every process). */
export async function searchMasters(db: Db): Promise<SearchMasters> {
  const [materialTypes, languages, collectionTypes, branches] = await Promise.all([
    db.selectFrom('material_types').select(['id', 'code_key', 'name_id', 'name_en']).orderBy('sort_order').orderBy('code_key').execute(),
    db.selectFrom('languages').select(['id', 'code_key', 'name_id', 'name_en']).orderBy('code_key').execute(),
    db.selectFrom('collection_types').select(['id', 'code_key', 'name_id', 'name_en']).orderBy('sort_order').orderBy('code_key').execute(),
    db.selectFrom('branches').select(['id', 'code_key', 'name']).orderBy('code_key').execute(),
  ]);
  const master = (r: { id: string; code_key: string; name_id: string; name_en: string }): SearchMaster => ({
    id: r.id,
    code: r.code_key,
    nameId: r.name_id,
    nameEn: r.name_en,
  });
  return {
    materialTypes: materialTypes.map(master),
    languages: languages.map(master),
    collectionTypes: collectionTypes.map(master),
    branches: branches.map((b) => ({ id: b.id, code: b.code_key, nameId: b.name, nameEn: b.name })),
  };
}

/** The lookups of {@link parseOpacSearchParams} from the masters. */
export function searchLookups(m: SearchMasters): OpacSearchLookups {
  const byCode = (list: readonly SearchMaster[]) => new Map(list.map((x) => [x.code, x.id]));
  return {
    materialTypeByCode: byCode(m.materialTypes),
    languageByCode: byCode(m.languages),
    collectionTypeByCode: byCode(m.collectionTypes),
    branchByCode: byCode(m.branches),
  };
}

/** The name of a master in `locale`. */
export function masterName(m: SearchMaster, locale: Locale): string {
  return locale === 'en' ? m.nameEn : m.nameId;
}
