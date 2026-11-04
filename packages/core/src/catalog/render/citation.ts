// Citations of a record (spec §9.3, D2-21): APA 7, MLA 9 and Chicago author-date, for a book-like record as a whole.
// Pure; the OPAC detail renders the parts (the title in <em>) and escapes them as any other text.
//
// - The connectors follow the UI language: `dan`/`and`, `dkk.`/`et al.`, `t.t.`/`n.d.`; APA keeps `&`.
// - The authors are the `aut`/`cre` agents and the main entry (names.ts `agentGroups`). With no author the editors
//   (`edt`) take their place: APA `(Ed.)`/`(Eds.)`, MLA `editor`/`editors`, Chicago `ed.`/`eds.`. With neither, the
//   title comes first. Editors next to an author, and every other role, are not cited.
// - APA lists up to 20 authors (more: the first 19, an ellipsis and the last), MLA names two and writes `et al.` for
//   three or more, Chicago lists up to ten (more: the first seven and `et al.`).
// - Titles are kept as catalogued (no case conversion); the subtitle's first letter is capitalised, as all three
//   styles do. Unlike APA, MLA and Chicago name the place: Chicago writes `Place: Publisher`, MLA the publisher only.

import type { RecordData } from '@altis/shared/api/catalog/record-data';
import {
  agentGroups,
  apaName,
  bare,
  directName,
  endPeriod,
  fullTitle,
  invertedName,
  placeOf,
  publisherOf,
  withoutFinalPeriod,
  yearOf,
  type RenderAgent,
} from './names.js';

/** A run of citation text; `em` marks the title, which the page sets in italics. */
export interface CitationPart {
  text: string;
  em?: boolean;
}

export type CitationStyle = 'apa' | 'mla' | 'chicago';

const WORDS = {
  id: { and: 'dan', etAl: 'dkk.', noDate: 't.t.', editor: 'editor', editors: 'editor' },
  en: { and: 'and', etAl: 'et al.', noDate: 'n.d.', editor: 'editor', editors: 'editors' },
} as const;

type Words = (typeof WORDS)[keyof typeof WORDS];

/** The pieces every style uses; the edition, publisher and place without a final period that a style would double. */
interface Pieces {
  title: string;
  edition: string;
  year: string | null;
  publisher: string;
  place: string;
  /** The authors, else the editors (`editors: true`), else none. */
  names: RenderAgent[];
  editors: boolean;
}

function pieces(d: RecordData): Pieces {
  const { creators, editors } = agentGroups(d);
  return {
    title: fullTitle(d, true),
    edition: withoutFinalPeriod(bare(d.edition)),
    year: yearOf(d),
    publisher: withoutFinalPeriod(publisherOf(d)),
    place: withoutFinalPeriod(placeOf(d)),
    names: creators.length > 0 ? creators : editors,
    editors: creators.length === 0 && editors.length > 0,
  };
}

/** The period after the title, unless the title already ends with `.`, `?` or `!`. */
function afterTitle(title: string): string {
  return /[.?!]$/.test(title) ? '' : '.';
}

/** Drops empty parts and joins neighbouring plain ones. */
function finish(parts: CitationPart[]): CitationPart[] {
  const out: CitationPart[] = [];
  for (const p of parts) {
    if (p.text === '') continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.em !== true && p.em !== true) last.text += p.text;
    else out.push(p.em === true ? { text: p.text, em: true } : { text: p.text });
  }
  const last = out[out.length - 1];
  if (last !== undefined && last.em !== true) last.text = last.text.trimEnd();
  return out;
}

/** `A, & B` / `A, B, & C`; more than 20: the first 19, `. . .` and the last (APA 7 §9.8). */
function apaList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > 20) return `${names.slice(0, 19).join(', ')}, . . . ${names[names.length - 1]!}`;
  return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]!}`;
}

function apaStyle(p: Pieces, w: Words): CitationPart[] {
  const year = `(${p.year ?? w.noDate}).`;
  // `Title (2nd ed.).`; a title ending in `?` takes no period of its own.
  const titleEnd = p.edition === '' ? afterTitle(p.title) : ` (${p.edition}).`;
  const publisher = p.publisher === '' ? '' : ` ${endPeriod(p.publisher)}`;
  if (p.names.length === 0) return finish([{ text: p.title, em: true }, { text: `${titleEnd} ${year}${publisher}` }]);
  const role = p.editors ? (p.names.length === 1 ? ' (Ed.)' : ' (Eds.)') : '';
  const author = endPeriod(apaList(p.names.map(apaName)) + role);
  return finish([{ text: `${author} ${year} ` }, { text: p.title, em: true }, { text: `${titleEnd}${publisher}` }]);
}

/** The lead of MLA and Chicago: the first name inverted, the others direct. */
function joinNames(names: RenderAgent[], w: Words, max: number, keep: number): string {
  const first = invertedName(names[0]!);
  if (names.length === 1) return first;
  if (names.length === 2) return `${first}${first.includes(',') ? ',' : ''} ${w.and} ${directName(names[1]!)}`;
  if (names.length > max) return `${[first, ...names.slice(1, keep).map(directName)].join(', ')}, ${w.etAl}`;
  const rest = names.slice(1).map(directName);
  return `${[first, ...rest.slice(0, -1)].join(', ')}, ${w.and} ${rest[rest.length - 1]!}`;
}

function mlaStyle(p: Pieces, w: Words): CitationPart[] {
  // MLA 9 names two authors; three or more are the first and et al.
  let lead = p.names.length === 0 ? '' : joinNames(p.names, w, 2, 1);
  if (p.editors) lead += `, ${p.names.length === 1 ? w.editor : w.editors}`;
  const elements = [p.edition, p.publisher, p.year ?? ''].filter((e) => e !== '');
  const tail = `${afterTitle(p.title)}${elements.length === 0 ? '' : ` ${endPeriod(elements.join(', '))}`}`;
  return finish([{ text: lead === '' ? '' : `${endPeriod(lead)} ` }, { text: p.title, em: true }, { text: tail }]);
}

function chicagoStyle(p: Pieces, w: Words): CitationPart[] {
  // Chicago 17 lists up to ten authors; more are the first seven and et al.
  let lead = p.names.length === 0 ? '' : joinNames(p.names, w, 10, 7);
  if (p.editors) lead += p.names.length === 1 ? ', ed.' : ', eds.';
  const year = endPeriod(p.year ?? w.noDate);
  const where = p.place !== '' && p.publisher !== '' ? `${p.place}: ${p.publisher}` : p.place || p.publisher;
  const tail = `${p.edition === '' ? '' : ` ${endPeriod(p.edition)}`}${where === '' ? '' : ` ${endPeriod(where)}`}`;
  if (lead === '') return finish([{ text: p.title, em: true }, { text: `${afterTitle(p.title)} ${year}${tail}` }]);
  return finish([{ text: `${endPeriod(lead)} ${year} ` }, { text: p.title, em: true }, { text: `${afterTitle(p.title)}${tail}` }]);
}

/**
 * The citation of `d` in `style`, as parts (the title emphasised), with the connectors of `locale` (the UI language).
 * Every text is plain and single-line; the caller escapes it.
 */
export function formatCitation(d: RecordData, style: CitationStyle, locale: 'id' | 'en'): CitationPart[] {
  const w = locale === 'en' ? WORDS.en : WORDS.id;
  const p = pieces(d);
  if (style === 'mla') return mlaStyle(p, w);
  if (style === 'chicago') return chicagoStyle(p, w);
  return apaStyle(p, w);
}
