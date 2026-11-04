import { uninvertName } from '../catalog/lib/names.js';
import type { CustomFieldDef } from '../catalog/data/custom-fields.js';
import type { LocationPath } from '../catalog/data/locations.js';
import { searchTokenize } from './tokenize.js';
import type { FacetName } from './types.js';

// One record's search document (Phase 2 spec §4.2, §4.6): its four token columns, its sort keys and its facet values,
// built from what index-records.ts loaded. Pure.
//
//   t_title     title, subtitle, series
//   t_agents    each agent's name, and a person's direct form (`Toer, Pramoedya Ananta` → `Pramoedya Ananta Toer`)
//   t_subjects  each subject's term and class, the record's classification
//   t_rest      identifiers (as written and their keys), publisher and place, call numbers and barcodes, the values of
//               the custom fields that are searchable AND public (S20: a staff-only value would let a visitor of the
//               public `/cari` test it), notes, summary
//
// Each column is cut to 60 000 UTF-8 bytes (MySQL TEXT holds 65 535 bytes; Review Focus 3, P2-19) at a token boundary,
// so the text stays valid UTF-8 and no token is cut; t_rest puts the short, structured values first, so a long summary
// is what loses its tail.
//
// Facets (§4.6): mt material type, lg language, ct collection types and br branches of the live items, lc the room of
// each located item, av `1` when a live item is `available` in a public location or has none, at the kind of each
// public live attachment (`pdf`, `audio`, `video`, `image`, `url`, `other`), sb the subjects, cl (M4) the first digit
// of the classification when it starts with one.

/** Each text column holds at most this many bytes of UTF-8 (P2-19). */
export const SEARCH_TEXT_MAX_BYTES = 60_000;

/** What a document is built from (index-records.ts loads it). */
export interface SearchDocSource {
  record: {
    id: string;
    material_type_id: string;
    title: string;
    subtitle: string | null;
    series: string | null;
    title_key: string;
    publication_place: string | null;
    publication_year: string | null;
    classification: string | null;
    call_number: string | null;
    language_id: string | null;
    summary: string | null;
    notes: string | null;
    opac_visible: number;
    archived_at: number | null;
    merged_into: string | null;
    created_at: number;
    changed_at: number;
  };
  identifiers: readonly { type: string; value_display: string; value_key: string }[];
  agents: readonly { type: string; name: string }[];
  subjects: readonly { id: string; term: string; classification: string | null }[];
  publisher: { name: string; place: string | null } | null;
  /** The record's live (not archived) items. */
  items: readonly {
    branch_id: string;
    location_id: string | null;
    collection_type_id: string;
    status: string;
    barcode_display: string;
    call_number: string | null;
  }[];
  /** The paths of the items' locations (locationPaths). */
  locations: ReadonlyMap<string, LocationPath>;
  /** The record's public, live attachments: `url`, or a file with its MIME type (null when its file row is gone). */
  attachments: readonly { kind: string; mime: string | null }[];
  /** The texts of the record's and its items' searchable public custom values (customSearchTexts). */
  customTexts: readonly string[];
}

/** The `search_doc` row of a record (without `doc_no`). */
export interface SearchDocRow {
  record_id: string;
  is_public: 0 | 1;
  is_archived: 0 | 1;
  t_title: string;
  t_agents: string;
  t_subjects: string;
  t_rest: string;
  title_key: string;
  year: number | null;
  created_at: number;
  changed_at: number;
}

/** A record's document and its facet values. */
export interface SearchDoc {
  row: SearchDocRow;
  facets: { facet: FacetName; value_key: string }[];
}

/**
 * The tokens joined by single spaces, keeping only the tokens that fit in `maxBytes` of UTF-8: the cut falls between
 * tokens, so the text stays valid UTF-8 and no token is half there.
 */
export function joinTokensWithin(tokens: readonly string[], maxBytes: number = SEARCH_TEXT_MAX_BYTES): string {
  let bytes = 0;
  let end = 0;
  for (; end < tokens.length; end += 1) {
    const add = Buffer.byteLength(tokens[end]!, 'utf8') + (end === 0 ? 0 : 1);
    if (bytes + add > maxBytes) break;
    bytes += add;
  }
  return tokens.slice(0, end).join(' ');
}

/** The tokens of every non-empty text of `texts`, in order. */
function tokensOf(texts: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of texts) if (typeof t === 'string' && t !== '') out.push(...searchTokenize(t));
  return out;
}

/** The MIME family of an attachment file (§4.6 `at`). */
function fileKind(mime: string | null): string {
  const m = (mime ?? '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'image';
  return 'other';
}

/** The first digit of a classification that starts with one (M4), else null. */
export function classDigitOf(classification: string | null): string | null {
  const c = (classification ?? '').trim();
  return /^[0-9]/.test(c) ? c[0]! : null;
}

/** The publication year as a number, when it is four digits. */
function yearOf(year: string | null): number | null {
  return year !== null && /^\d{4}$/.test(year.trim()) ? Number(year.trim()) : null;
}

/**
 * The texts a custom value contributes to `t_rest` (§3.7): text, long text and URL values as they are, a number or a
 * date as written, the chosen options of a select or multiselect field with their labels in both languages; nothing
 * for a boolean or a value of another shape.
 */
export function customSearchTexts(def: CustomFieldDef, value: unknown): string[] {
  switch (def.type) {
    case 'text':
    case 'longtext':
    case 'url':
    case 'date':
      return typeof value === 'string' ? [value] : [];
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [String(value)] : [];
    case 'select':
    case 'multiselect': {
      const chosen = Array.isArray(value) ? value : [value];
      const out: string[] = [];
      for (const v of chosen) {
        if (typeof v !== 'string') continue;
        const option = def.options.find((o) => o.value === v);
        out.push(v);
        if (option !== undefined) out.push(option.labelId, ...(option.labelEn === null ? [] : [option.labelEn]));
      }
      return out;
    }
    default:
      return [];
  }
}

/** The search document of one record (see the top of this file). */
export function buildSearchDoc(src: SearchDocSource): SearchDoc {
  const r = src.record;
  const tTitle = tokensOf([r.title, r.subtitle, r.series]);
  const tAgents = tokensOf(src.agents.flatMap((a) => (a.type === 'person' ? [a.name, uninvertName(a.name)] : [a.name])));
  const tSubjects = tokensOf([...src.subjects.flatMap((s) => [s.term, s.classification]), r.classification]);
  const tRest = tokensOf([
    ...src.identifiers.flatMap((i) => [i.value_display, i.value_key]),
    src.publisher?.name,
    src.publisher?.place,
    r.publication_place,
    r.call_number,
    ...src.items.flatMap((i) => [i.call_number, i.barcode_display]),
    ...src.customTexts,
    r.notes,
    r.summary,
  ]);

  const facets = new Map<string, { facet: FacetName; value_key: string }>();
  const facet = (name: FacetName, value: string | null | undefined): void => {
    if (typeof value === 'string' && value !== '') facets.set(`${name}\u{0}${value}`, { facet: name, value_key: value });
  };
  facet('mt', r.material_type_id);
  facet('lg', r.language_id);
  for (const item of src.items) {
    facet('ct', item.collection_type_id);
    facet('br', item.branch_id);
    const path = item.location_id === null ? undefined : src.locations.get(item.location_id);
    facet('lc', path?.roomId);
    // An item without a location (or whose location is gone) is on no closed shelf: it counts as reachable.
    if (item.status === 'available' && (path === undefined || path.isPublic)) facet('av', '1');
  }
  for (const a of src.attachments) facet('at', a.kind === 'url' ? 'url' : fileKind(a.mime));
  for (const s of src.subjects) facet('sb', s.id);
  facet('cl', classDigitOf(r.classification));

  const live = r.archived_at === null;
  return {
    row: {
      record_id: r.id,
      is_public: r.opac_visible === 1 && live && r.merged_into === null ? 1 : 0,
      is_archived: live ? 0 : 1,
      t_title: joinTokensWithin(tTitle),
      t_agents: joinTokensWithin(tAgents),
      t_subjects: joinTokensWithin(tSubjects),
      t_rest: joinTokensWithin(tRest),
      title_key: r.title_key,
      year: yearOf(r.publication_year),
      created_at: r.created_at,
      changed_at: r.changed_at,
    },
    facets: [...facets.values()],
  };
}
