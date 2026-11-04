// Dublin Core of a record: the values of each DC element (spec §10's `oai_dc` list) and the `DC.*` meta of the OPAC
// detail's <head> (§9.3). Pure; the page escapes the contents as any attribute value.
//
// One mapping serves both:
// - title: `title: subtitle`;
// - creator: the authors (`aut`/`cre`/main entry); contributor: every other agent; both as catalogued (inverted),
//   with their dates;
// - subject: the subjects that are not geographic, then the classification (DDC); coverage: the geographic subjects;
// - description: the summary, the notes; publisher; date: the year;
// - type: the DCMI type and the material type's English name; format: the physical description;
// - identifier: the OPAC URL, `urn:isbn:<13 digits>`, `urn:issn:<NNNN-NNNN>`, the DOI as a resolver URL;
// - language: the MARC code; relation: the series, then the OPAC URLs of related records.
// The `DC.*` meta are §9.3's nine elements; there the public http(s) links (re-checked, S4) are further identifiers.

import type { RecordData } from '@altis/shared/api/catalog/record-data';
import {
  agentGroups,
  bare,
  doisOf,
  doiUrl,
  fullTitle,
  httpUrl,
  invertedName,
  isbnsOf,
  issnsOf,
  languageCodeOf,
  multiLine,
  oneLine,
  publicLinks,
  publisherOf,
  relatedUrls,
  yearOf,
  type RecordRenderOptions,
  type RenderAgent,
} from './names.js';

/** The DC elements a record fills, in §10's order. */
export const DC_ELEMENTS = Object.freeze([
  'title',
  'creator',
  'contributor',
  'subject',
  'description',
  'publisher',
  'date',
  'type',
  'format',
  'identifier',
  'language',
  'relation',
  'coverage',
] as const);

export type DcElement = (typeof DC_ELEMENTS)[number];

/** The elements of the `DC.*` meta (§9.3), in that order. */
const DC_META_ELEMENTS: readonly DcElement[] = Object.freeze(['title', 'creator', 'subject', 'date', 'publisher', 'language', 'identifier', 'type', 'format']);

function agentText(a: RenderAgent): string {
  const dates = oneLine(a.dates);
  return dates === '' ? invertedName(a) : `${invertedName(a)}, ${dates}`;
}

/** Each element's values for `d`: non-empty, without duplicates, in order (internal to the render area). */
export function dcValues(d: RecordData, o: RecordRenderOptions): Record<DcElement, string[]> {
  const out = Object.fromEntries(DC_ELEMENTS.map((e) => [e, [] as string[]])) as unknown as Record<DcElement, string[]>;
  const add = (e: DcElement, value: string | null): void => {
    if (value !== null && value !== '' && !out[e].includes(value)) out[e].push(value);
  };
  const { creators, editors, others } = agentGroups(d);

  add('title', fullTitle(d));
  for (const a of creators) add('creator', agentText(a));
  for (const a of [...editors, ...others]) add('contributor', agentText(a));
  for (const s of d.subjects) if (s.type !== 'geographic') add('subject', bare(s.term));
  add('subject', bare(d.classification));
  add('description', multiLine(d.summary));
  add('description', multiLine(d.notes));
  add('publisher', publisherOf(d));
  add('date', yearOf(d));
  add('type', oneLine(d.materialType.dcmiType));
  add('type', oneLine(d.materialType.nameEn));
  add('format', bare(d.physicalDesc));
  add('identifier', httpUrl(o.canonicalUrl));
  for (const isbn of isbnsOf(d)) add('identifier', `urn:isbn:${isbn.key}`);
  for (const issn of issnsOf(d)) add('identifier', `urn:issn:${issn}`);
  for (const doi of doisOf(d)) add('identifier', doiUrl(doi));
  add('language', languageCodeOf(d));
  add('relation', bare(d.series));
  for (const url of relatedUrls(d, o)) add('relation', url);
  for (const s of d.subjects) if (s.type === 'geographic') add('coverage', bare(s.term));
  return out;
}

/** The `DC.*` meta of the detail page (§9.3); the page adds `<link rel="schema.DC" href="http://purl.org/dc/elements/1.1/">`. */
export function dublinCoreMeta(d: RecordData, o: RecordRenderOptions): { name: string; content: string }[] {
  const values = dcValues(d, o);
  for (const link of publicLinks(d)) if (!values.identifier.includes(link.url)) values.identifier.push(link.url);
  return DC_META_ELEMENTS.flatMap((e) => values[e].map((content) => ({ name: `DC.${e}`, content: oneLine(content) })));
}
