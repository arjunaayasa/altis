// What the bibliographic renderers (Phase 2 Task 22) name of a record: its title, its agents and their names, its
// identifiers, year, place and publisher, and its public links. Internal to the render area (not in its barrel, M14).
// Pure; no I/O.
//
// Every value here is catalogue data and so untrusted (an import, an SRU answer, a migration may have written it): the
// helpers return plain text with line breaks and control characters removed, and each renderer escapes for its own
// format. A URL is written only when it is http/https, checked again here (S4).

import { isHttpUrl, URL_MAX } from '@altis/shared/api/catalog/common';
import type { RecordData } from '@altis/shared/api/catalog/record-data';
import { normalizeDoi, parseIsbn, parseIssn } from '../lib/identifiers.js';
import { uninvertName } from '../lib/names.js';
import { recordUrlPath } from '../lib/slug.js';
import { stripInvalidXmlChars } from '../../xml/writer.js';

export type RenderAgent = RecordData['agents'][number];

/** The options every renderer takes. */
export interface RecordRenderOptions {
  /** `config.baseUrl`: the URLs of related records are built from it, never from a request's Host. */
  baseUrl: string;
  /** The record's canonical OPAC URL (`<baseUrl>/katalog/<id>/<slug>`). */
  canonicalUrl: string;
  /** The UI language: the citations' connectors, the RIS language name, `og:locale`. */
  locale: 'id' | 'en';
  /** The cover's absolute URL, or null when the record has none. */
  coverUrl: string | null;
}

// ---- text ---------------------------------------------------------------------------------------------------------

/** A run of whitespace and/or control characters: one space when it holds whitespace, nothing otherwise. */
const SPACE_OR_CONTROL_RE = /[\s\p{Cc}]+/gu;
const HAS_SPACE_RE = /\s/u;

/**
 * One line of text: line breaks and other whitespace runs become one space, control characters and the other
 * characters XML 1.0 forbids (lone surrogates, U+FFFE, U+FFFF) go, trimmed.
 */
export function oneLine(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return stripInvalidXmlChars(s)
    .replace(SPACE_OR_CONTROL_RE, (m) => (HAS_SPACE_RE.test(m) ? ' ' : ''))
    .trim();
}

/** Control characters other than TAB and LF. */
const CONTROL_BUT_TAB_LF_RE = /[^\P{Cc}\t\n]/gu;

/**
 * A text of several lines (a summary, a note): CRLF and CR become LF, other control characters and the characters XML
 * 1.0 forbids go, trimmed.
 */
export function multiLine(s: string | null | undefined): string {
  if (typeof s !== 'string') return '';
  return stripInvalidXmlChars(s).replace(/\r\n?/g, '\n').replace(CONTROL_BUT_TAB_LF_RE, '').trim();
}

/** ISBD punctuation that may open or close a catalogued value (`Laskar pelangi :`, `/ Andrea Hirata`). */
const ISBD_ENDS_RE = /^[\s,;:/=]+|[\s,;:/=]+$/gu;

/** {@link oneLine} without ISBD punctuation at either end; a final `.` is kept (it may end an abbreviation). */
export function bare(s: string | null | undefined): string {
  return oneLine(s).replace(ISBD_ENDS_RE, '');
}

/** `s` with a final period, unless it already ends with `.`, `?` or `!`. */
export function endPeriod(s: string): string {
  return /[.?!]$/.test(s) ? s : `${s}.`;
}

/**
 * `s` without a final period, unless its last word is a short abbreviation (`2nd ed.`, `rev.`): `Cetakan ke-5.` →
 * `Cetakan ke-5`, so that a style's own punctuation can follow without doubling it.
 */
export function withoutFinalPeriod(s: string): string {
  if (!s.endsWith('.')) return s;
  const last = s.slice(s.lastIndexOf(' ') + 1, -1);
  return /^\p{L}{1,4}$/u.test(last) ? s : s.slice(0, -1).trimEnd();
}

/**
 * At most `max` characters (code points): cut at the last word boundary, with an ellipsis. Short texts are unchanged.
 */
export function cutText(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  let head = chars.slice(0, max - 1).join('');
  if (!HAS_SPACE_RE.test(chars[max - 1]!)) {
    const space = head.lastIndexOf(' ');
    if (space > max / 2) head = head.slice(0, space);
  }
  return `${head.replace(/[\s,;:.]+$/u, '')}\u{2026}`;
}

// ---- the record's parts -------------------------------------------------------------------------------------------

/** The schema.org types a material type may name (§9.4); anything else is written as `CreativeWork`. */
const SCHEMA_TYPES: ReadonlySet<string> = new Set(['Book', 'Thesis', 'Periodical', 'Map', 'AudioObject', 'VideoObject', 'CreativeWork']);

export type RenderSchemaType = 'Book' | 'Thesis' | 'Periodical' | 'Map' | 'AudioObject' | 'VideoObject' | 'CreativeWork';

/** The record's schema.org type (`material_types.schema_type`), `CreativeWork` when it is not one of §9.4's. */
export function schemaTypeOf(d: RecordData): RenderSchemaType {
  const t = d.materialType.schemaType;
  return SCHEMA_TYPES.has(t) ? (t as RenderSchemaType) : 'CreativeWork';
}

/**
 * The title and the subtitle joined with `": "` (§10 `dc:title`), each without ISBD punctuation at its ends. For a
 * citation (`citation: true`) the subtitle's first letter is capitalised, and a title ending in `?` or `!` is followed
 * by a space only.
 */
export function fullTitle(d: RecordData, citation = false): string {
  const title = bare(d.title) || oneLine(d.title);
  let sub = bare(d.subtitle);
  if (sub === '') return title;
  if (title === '') return sub;
  if (!citation) return `${title}: ${sub}`;
  sub = sub.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  return /[?!]$/.test(title) ? `${title} ${sub}` : `${title}: ${sub}`;
}

/** The year of publication (`YYYY`, as the record stores it), or null. */
export function yearOf(d: RecordData): string | null {
  const y = oneLine(d.publicationYear);
  return /^\d{4}$/.test(y) && y !== '0000' ? y : null;
}

/** The place of publication: the record's own, else the publisher authority's; `''` when unknown. */
export function placeOf(d: RecordData): string {
  return bare(d.publicationPlace) || bare(d.publisher?.place);
}

/** The publisher's name, `''` when there is none. */
export function publisherOf(d: RecordData): string {
  return bare(d.publisher?.name);
}

/** The record's language code (MARC, as stored), `''` when there is none. */
export function languageCodeOf(d: RecordData): string {
  return oneLine(d.language?.code ?? d.languageCode);
}

// ---- agents -------------------------------------------------------------------------------------------------------

export interface AgentGroups {
  /** The authors: `aut` and `cre`, and the main entry unless it is an editor; the main entry first. */
  creators: RenderAgent[];
  /** The editors (`edt`) that are not creators. */
  editors: RenderAgent[];
  /** Every other agent (translators, illustrators, ...). */
  others: RenderAgent[];
}

/** The record's agents by what a citation does with them; an agent (by id) is in one group only, in stored order. */
export function agentGroups(d: RecordData): AgentGroups {
  const ordered = [...d.agents].filter((a) => bare(a.name) !== '').sort((x, y) => Number(y.isMain) - Number(x.isMain));
  const seen = new Set<string>();
  const take = (pick: (a: RenderAgent) => boolean): RenderAgent[] => {
    const out: RenderAgent[] = [];
    for (const a of ordered) {
      if (seen.has(a.id) || !pick(a)) continue;
      seen.add(a.id);
      out.push(a);
    }
    return out;
  };
  const creators = take((a) => a.role === 'aut' || a.role === 'cre' || (a.isMain && a.role !== 'edt'));
  const editors = take((a) => a.role === 'edt');
  const others = take(() => true);
  return { creators, editors, others };
}

export interface NameParts {
  family: string;
  given: string;
  /** `Jr.`, `III`; `''` when there is none. */
  suffix: string;
}

/**
 * A person's inverted name (`Toer, Pramoedya Ananta`) in its parts, or null for a single name: an organisation, a
 * meeting, or a person stored without a comma (`Soekarno`, spec §2.1).
 */
export function nameParts(a: RenderAgent): NameParts | null {
  if (a.type !== 'person') return null;
  const s = bare(a.name);
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const family = s.slice(0, comma).trim();
  const rest = s
    .slice(comma + 1)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (family === '' || rest.length === 0) return null;
  return { family, given: rest[0]!, suffix: rest.slice(1).join(', ') };
}

/** The name as catalogued: a person inverted (`Hirata, Andrea`), any other name as is. */
export function invertedName(a: RenderAgent): string {
  const p = nameParts(a);
  if (p === null) return bare(a.name);
  return p.suffix === '' ? `${p.family}, ${p.given}` : `${p.family}, ${p.given}, ${p.suffix}`;
}

/** The direct form: a person `Andrea Hirata` (Task 5's `uninvertName`), any other name as is. */
export function directName(a: RenderAgent): string {
  return a.type === 'person' ? bare(uninvertName(oneLine(a.name))) : bare(a.name);
}

/** Lower-case name particles kept whole among the initials (`Beethoven, L. van`). */
const PARTICLES: ReadonlySet<string> = new Set([
  'al',
  'bin',
  'binti',
  'da',
  'das',
  'de',
  'del',
  'della',
  'den',
  'der',
  'di',
  'dos',
  'du',
  'el',
  'ibn',
  'la',
  'le',
  'ten',
  'ter',
  'van',
  'von',
]);

/** The initial of one part of a given name: its first letter, upper-cased, with a period; `''` without a letter. */
function initial(part: string): string {
  const m = /\p{L}/u.exec(part);
  return m === null ? '' : `${m[0].toUpperCase()}.`;
}

/** APA's initials of a given name: `Pramoedya Ananta` → `P. A.`, `Jean-Paul` → `J.-P.`, particles kept. */
function initials(given: string): string {
  return given
    .split(' ')
    .filter((w) => w !== '')
    .map((w) =>
      PARTICLES.has(w)
        ? w
        : w
            .split('-')
            .map(initial)
            .filter((x) => x !== '')
            .join('-'),
    )
    .filter((w) => w !== '')
    .join(' ');
}

/** A name as APA writes it: `Toer, P. A.`, `King, M. L., Jr.`; a single name as is. */
export function apaName(a: RenderAgent): string {
  const p = nameParts(a);
  if (p === null) return bare(a.name);
  const given = initials(p.given);
  const head = given === '' ? p.family : `${p.family}, ${given}`;
  return p.suffix === '' ? head : `${head}, ${p.suffix}`;
}

// ---- identifiers --------------------------------------------------------------------------------------------------

/** The record's ISBNs that parse (`key`: 13 digits; `display`: as written, normalised), without duplicates. */
export function isbnsOf(d: RecordData): { key: string; display: string }[] {
  const out: { key: string; display: string }[] = [];
  const seen = new Set<string>();
  for (const i of d.identifiers) {
    if (i.type !== 'isbn') continue;
    const p = parseIsbn(oneLine(i.value));
    if (p === null || seen.has(p.key)) continue;
    seen.add(p.key);
    out.push({ key: p.key, display: oneLine(p.display) });
  }
  return out;
}

/** The record's ISSNs that parse, hyphenated (`1411-4348`), without duplicates. */
export function issnsOf(d: RecordData): string[] {
  const out: string[] = [];
  for (const i of d.identifiers) {
    if (i.type !== 'issn') continue;
    const p = parseIssn(oneLine(i.value));
    if (p === null) continue;
    const hyphenated = `${p.key.slice(0, 4)}-${p.key.slice(4)}`;
    if (!out.includes(hyphenated)) out.push(hyphenated);
  }
  return out;
}

/** The record's DOIs that parse (`10.1234/abc`, lower case), without duplicates. */
export function doisOf(d: RecordData): string[] {
  const out: string[] = [];
  for (const i of d.identifiers) {
    if (i.type !== 'doi') continue;
    const doi = normalizeDoi(oneLine(i.value));
    if (doi !== null && !out.includes(doi)) out.push(doi);
  }
  return out;
}

/** A DOI as a resolver URL, each path segment percent-encoded. */
export function doiUrl(doi: string): string {
  return `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`;
}

// ---- URLs (S4) ----------------------------------------------------------------------------------------------------

/** `s` trimmed when it is an absolute http(s) URL of at most 2000 characters (S4), else null. */
export function httpUrl(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const u = s.trim();
  return u.length <= URL_MAX && isHttpUrl(u) ? u : null;
}

/**
 * The record's public URL attachments whose URL is http(s), checked again here (S4), without duplicates. Read from
 * `attachments`, never from `links`: a staff load's `links` hold staff links too, and every output here is public.
 */
export function publicLinks(d: RecordData): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const a of d.attachments) {
    if (a.kind !== 'url' || a.access !== 'public') continue;
    const url = httpUrl(a.url);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: oneLine(a.title) });
  }
  return out;
}

/** The OPAC URLs of the related records (both directions), from `baseUrl`, without duplicates. */
export function relatedUrls(d: RecordData, o: RecordRenderOptions): string[] {
  const base = o.baseUrl.replace(/\/+$/, '');
  const out: string[] = [];
  for (const r of d.relations) {
    const url = httpUrl(`${base}${recordUrlPath(r.recordId, r.title)}`);
    if (url !== null && !out.includes(url)) out.push(url);
  }
  return out;
}
