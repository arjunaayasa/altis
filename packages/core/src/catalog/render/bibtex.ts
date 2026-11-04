// BibTeX of a record (spec §9.1 `/katalog/:id/bibtex`, D2-21). Pure.
//
// - `@book` for a book, `@misc` for every other type (a thesis, a serial, a map, ... whose BibTeX types need fields
//   the catalogue does not hold, such as the school).
// - The key is `<familyname><year>`: the first author's (or editor's) family name, or the first word of a single name
//   or of the title, folded to `a-z0-9`; `ref` when nothing is left.
// - Catalogue text is untrusted: `\ { } & % $ # _ ~ ^` are escaped, so a value can neither close its field nor run a
//   LaTeX command; an unpaired brace becomes `\textbraceleft{}`/`\textbraceright{}`, since BibTeX counts `\{` too.
//   `url` and `doi` are verbatim fields and are written only when they hold no brace, backslash or whitespace.
// - Persons are `Family, Given` (`Family, Jr., Given` with a suffix), joined with `and`; a single name is braced so
//   that BibTeX neither splits it nor reads an `and` inside it.

import type { RecordData } from '@altis/shared/api/catalog/record-data';
import { foldForKey } from '../lib/title-key.js';
import {
  agentGroups,
  bare,
  doisOf,
  fullTitle,
  httpUrl,
  isbnsOf,
  issnsOf,
  nameParts,
  placeOf,
  publisherOf,
  schemaTypeOf,
  yearOf,
  type RecordRenderOptions,
  type RenderAgent,
} from './names.js';

const LATEX_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
});

/** Braces as LaTeX text commands, for a value whose braces do not pair up. */
const TEXT_BRACES: Readonly<Record<string, string>> = Object.freeze({ '{': '\\textbraceleft{}', '}': '\\textbraceright{}' });

/** Whether the braces of `s` pair up: no prefix closes more than it opened, and all are closed. */
function bracesPair(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Text for a braced BibTeX field: the LaTeX specials escaped in one pass. BibTeX matches a field's braces without
 * regard to backslashes, so `\{` still counts: braces that pair up are written `\{ \}`, any others as
 * `\textbraceleft{}`/`\textbraceright{}`, and the entry always stays balanced.
 */
function latex(s: string): string {
  const braces = bracesPair(s) ? LATEX_ESCAPES : TEXT_BRACES;
  return s.replace(/[\\{}&%$#_~^]/g, (c) => (c === '{' || c === '}' ? braces[c]! : LATEX_ESCAPES[c]!));
}

/** A value for a verbatim field (`url`, `doi`), or null when it holds a brace, a backslash or whitespace. */
function verbatim(s: string | null | undefined): string | null {
  return typeof s === 'string' && s !== '' && !/[{}\\\s\p{Cc}]/u.test(s) ? s : null;
}

/** One name of an `author`/`editor` field. */
function bibName(a: RenderAgent): string {
  const p = nameParts(a);
  if (p === null) return `{${latex(bare(a.name))}}`;
  const name = p.suffix === '' ? `${p.family}, ${p.given}` : `${p.family}, ${p.suffix}, ${p.given}`;
  return /\sand\s/i.test(name) ? `{${latex(name)}}` : latex(name);
}

/** The first word of `s` that folds to something in `a-z0-9`, folded; `''` when none does. */
function keyWord(s: string): string {
  for (const word of foldForKey(s).split(' ')) {
    const k = word.replace(/[^a-z0-9]/g, '');
    if (k !== '') return k;
  }
  return '';
}

function citationKey(d: RecordData): string {
  const { creators, editors } = agentGroups(d);
  const first = creators[0] ?? editors[0];
  let base = '';
  if (first !== undefined) {
    const p = nameParts(first);
    base = p === null ? keyWord(bare(first.name)) : foldForKey(p.family).replace(/[^a-z0-9]/g, '');
  }
  if (base === '') base = keyWord(bare(d.title));
  return `${base === '' ? 'ref' : base}${yearOf(d) ?? ''}`;
}

/** The BibTeX entry of `d`, ending with a line end. */
export function toBibtex(d: RecordData, o: RecordRenderOptions): string {
  const fields: [string, string][] = [];
  const field = (name: string, value: string | null): void => {
    if (value !== null && value !== '') fields.push([name, value]);
  };
  const { creators, editors } = agentGroups(d);

  field('author', creators.map(bibName).join(' and '));
  if (creators.length === 0) field('editor', editors.map(bibName).join(' and '));
  field('title', latex(fullTitle(d)));
  field('edition', latex(bare(d.edition)));
  field('series', latex(bare(d.series)));
  field('publisher', latex(publisherOf(d)));
  field('address', latex(placeOf(d)));
  field('year', yearOf(d));
  field('isbn', latex(isbnsOf(d).map((i) => i.display).join(', ')));
  field('issn', latex(issnsOf(d).join(', ')));
  field('doi', verbatim(doisOf(d)[0]));
  field('url', verbatim(httpUrl(o.canonicalUrl)));

  const type = schemaTypeOf(d) === 'Book' ? 'book' : 'misc';
  return `@${type}{${citationKey(d)},\n${fields.map(([name, value]) => `  ${name} = {${value}}`).join(',\n')}\n}\n`;
}
