// RIS of a record (spec §9.1 `/katalog/:id/ris`, D2-21): the tagged format reference managers import. Pure.
//
// Lines are `XX  - value` with CRLF; every value is one line (names.ts `oneLine`), so no catalogue text can start a
// tag of its own, and the record ends with `ER  - `. Tags: TY, AU (authors), A2 (editors when there is no author),
// TI (title: subtitle), T2 (series), ET, PY, CY, PB, SN (ISBNs, ISSNs), DO, LA, KW (subjects), AB (summary), N1
// (notes), UR (the OPAC URL, then the public http(s) links, re-checked: S4). No acquisition data is part of the input.

import type { RecordData } from '@altis/shared/api/catalog/record-data';
import {
  agentGroups,
  bare,
  doisOf,
  fullTitle,
  httpUrl,
  invertedName,
  isbnsOf,
  issnsOf,
  multiLine,
  oneLine,
  placeOf,
  publicLinks,
  publisherOf,
  schemaTypeOf,
  yearOf,
  type RecordRenderOptions,
  type RenderSchemaType,
} from './names.js';

/** The RIS reference type of each schema.org type. */
const RIS_TYPES: Readonly<Record<RenderSchemaType, string>> = Object.freeze({
  Book: 'BOOK',
  Thesis: 'THES',
  Periodical: 'SER',
  Map: 'MAP',
  AudioObject: 'SOUND',
  VideoObject: 'VIDEO',
  CreativeWork: 'GEN',
});

/** The RIS record of `d`: CRLF line ends, ending with `ER  - ` and a line end. */
export function toRis(d: RecordData, o: RecordRenderOptions): string {
  const lines: string[] = [];
  const tag = (name: string, value: string | null | undefined): void => {
    const v = oneLine(value);
    if (v !== '') lines.push(`${name}  - ${v}`);
  };
  const { creators, editors } = agentGroups(d);

  tag('TY', RIS_TYPES[schemaTypeOf(d)]);
  for (const a of creators) tag('AU', invertedName(a));
  if (creators.length === 0) for (const a of editors) tag('A2', invertedName(a));
  tag('TI', fullTitle(d));
  tag('T2', bare(d.series));
  tag('ET', bare(d.edition));
  tag('PY', yearOf(d));
  tag('CY', placeOf(d));
  tag('PB', publisherOf(d));
  for (const isbn of isbnsOf(d)) tag('SN', isbn.display);
  for (const issn of issnsOf(d)) tag('SN', issn);
  for (const doi of doisOf(d)) tag('DO', doi);
  tag('LA', o.locale === 'en' ? (d.language?.nameEn ?? d.languageCode) : (d.language?.nameId ?? d.languageCode));
  for (const s of d.subjects) tag('KW', bare(s.term));
  tag('AB', multiLine(d.summary));
  tag('N1', multiLine(d.notes));
  tag('UR', httpUrl(o.canonicalUrl));
  for (const link of publicLinks(d)) tag('UR', link.url);
  lines.push('ER  - ');
  return `${lines.join('\r\n')}\r\n`;
}
