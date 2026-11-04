import { describe, expect, it } from 'vitest';
import { QUERY_CLAUSES_MAX, QUERY_TEXT_MAX, parseQuery, type ParsedClause } from '../../src/search/query-parse.js';

// Phase 2 spec §4.4: words separated by spaces = AND; "exact phrase"; -word = except; ATAU / OR (upper case) between
// two words; word* = prefix (≥ 3 characters); the fields judul:, pengarang:, subjek:, isbn:, penerbit:, nomor: and the
// English title:, author:, subject:, publisher:, callno:. Broken syntax never fails: what is not understood is a word.

/** A compact view of the clauses: `-` for a negated clause, `|` between alternatives, `field:` when not `all`. */
function view(clauses: readonly ParsedClause[]): string[] {
  return clauses.map(
    (c) =>
      (c.negated ? '-' : '') +
      c.terms
        .map((t) => {
          const field = t.field === 'all' ? '' : `${t.field}:`;
          const body = t.phrase ? `"${t.tokens.join(' ')}"` : t.tokens.join(' ');
          return `${field}${body}${t.prefix ? '*' : ''}`;
        })
        .join('|'),
  );
}

const parsed = (q: string) => view(parseQuery(q).clauses);

describe('parseQuery', () => {
  it('words are ANDed clauses of encoded tokens', () => {
    expect(parsed('Laskar Pelangi')).toEqual(['laskar', 'pelangi']);
    expect(parsed('AI and the people')).toEqual(['zqai', 'and', 'zqthe', 'people']);
    expect(parsed('   ')).toEqual([]);
    expect(parsed('')).toEqual([]);
  });

  it('a quoted phrase is one clause whose tokens must be adjacent', () => {
    expect(parsed('"laskar pelangi" hirata')).toEqual(['"laskar pelangi"', 'hirata']);
    expect(parsed('"pelangi"')).toEqual(['pelangi']);
    expect(parseQuery('"pelangi"').clauses[0]!.terms[0]!.phrase).toBe(false);
  });

  it('a word that splits into several tokens is a phrase of them (e-book, C++ stays one token)', () => {
    expect(parsed('e-book')).toEqual(['"zqe book"']);
    expect(parsed('C++')).toEqual(['zqc']);
  });

  it('-word, -"phrase" and -field:word exclude; a lone - is nothing', () => {
    expect(parsed('hirata -edensor')).toEqual(['hirata', '-edensor']);
    expect(parsed('-novel')).toEqual(['-novel']);
    expect(parsed('-"laskar pelangi"')).toEqual(['-"laskar pelangi"']);
    expect(parsed('-pengarang:hirata')).toEqual(['-author:hirata']);
    expect(parsed('- novel')).toEqual(['novel']);
    expect(parsed('novel-sejarah')).toEqual(['"novel sejarah"']);
  });

  it('OR / ATAU in upper case between two words joins them; anywhere else it is a plain word', () => {
    expect(parsed('laskar OR edensor')).toEqual(['laskar|edensor']);
    expect(parsed('laskar ATAU edensor ATAU "sang pemimpi"')).toEqual(['laskar|edensor|"sang pemimpi"']);
    expect(parsed('a OR b c')).toEqual(['zqa|zqb', 'zqc']);
    expect(parsed('laskar or edensor')).toEqual(['laskar', 'zqor', 'edensor']);
    expect(parsed('OR laskar')).toEqual(['zqor', 'laskar']);
    expect(parsed('laskar OR')).toEqual(['laskar', 'zqor']);
    expect(parsed('laskar OR -edensor')).toEqual(['laskar', 'zqor', '-edensor']);
    expect(parsed('laskar OR OR edensor')).toEqual(['laskar', 'zqor', 'zqor', 'edensor']);
  });

  it('word* is a prefix of at least 3 characters; a shorter one is a plain word', () => {
    expect(parsed('pemrog*')).toEqual(['pemrog*']);
    expect(parsed('Pemrog**')).toEqual(['pemrog*']);
    expect(parsed('ab*')).toEqual(['zqab']);
    expect(parsed('*')).toEqual([]);
    // A prefix keeps its raw form: it must also match the words it begins (the stopword forms are added by sql.ts).
    expect(parseQuery('the*').clauses[0]!.terms[0]).toMatchObject({ prefix: true, words: ['the'] });
  });

  it('fields, Indonesian and English, any case; an unknown field is plain text', () => {
    expect(parsed('judul:laskar pengarang:hirata subjek:novel isbn:x penerbit:bentang nomor:b001')).toEqual([
      'title:laskar',
      'author:hirata',
      'subject:novel',
      'isbn:zqx',
      'publisher:bentang',
      'callno:b001',
    ]);
    expect(parsed('Title:"laskar pelangi" AUTHOR:hirata subject:novel publisher:bentang callno:899')).toEqual([
      'title:"laskar pelangi"',
      'author:hirata',
      'subject:novel',
      'publisher:bentang',
      'callno:899',
    ]);
    expect(parsed('foo:bar')).toEqual(['"foo bar"']);
    expect(parsed('judul:')).toEqual(['judul']);
    expect(parsed('judul: laskar')).toEqual(['judul', 'laskar']);
  });

  it('an ISBN word is its 13-digit key; isbn: takes any ISBN/ISSN shape, its check digit unchecked', () => {
    expect(parsed('laskar 978-602-03-3295-6')).toEqual(['laskar', '9786020332956']);
    expect(parsed('isbn:978-602-03-3295-7')).toEqual(['isbn:9786020332957']);
    expect(parsed('isbn:0317-8471')).toEqual(['isbn:03178471']);
  });

  it('an unbalanced quote is ignored', () => {
    expect(parsed('"laskar pelangi')).toEqual(['laskar', 'pelangi']);
    expect(parsed('laskar" pelangi')).toEqual(['laskar', 'pelangi']);
  });

  it('keeps each term as typed and its raw words (for the spelling correction)', () => {
    const [clause] = parseQuery('Pendidkan').clauses;
    expect(clause!.terms[0]).toMatchObject({ text: 'Pendidkan', words: ['pendidkan'], tokens: ['pendidkan'], prefix: false, phrase: false });
  });

  it('bounds the work: the text is read up to QUERY_TEXT_MAX characters and at most QUERY_CLAUSES_MAX clauses', () => {
    expect(parseQuery(`${'kata '.repeat(100)}`).clauses).toHaveLength(QUERY_CLAUSES_MAX);
    expect(parseQuery('x'.repeat(QUERY_TEXT_MAX * 3)).clauses[0]!.terms[0]!.text.length).toBeLessThanOrEqual(QUERY_TEXT_MAX);
  });

  it('500 random strings never throw, and every clause it makes is well formed', () => {
    const alphabet = ['a', 'Z', '9', ' ', ' ', '"', '-', '*', ':', 'OR', 'ATAU', 'judul:', 'isbn:', '\u{0301}', '\u{D800}', '\u{0000}', '東', '+', '(', ')', '\\', "'"];
    let seed = 0x2f6b_1d3c;
    const random = (n: number): number => {
      // xorshift32: the same 500 strings on every run
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    for (let i = 0; i < 500; i += 1) {
      let q = '';
      const len = random(40);
      for (let k = 0; k < len; k += 1) q += alphabet[random(alphabet.length)]!;
      let result: ReturnType<typeof parseQuery> | undefined;
      expect(() => (result = parseQuery(q)), JSON.stringify(q)).not.toThrow();
      for (const clause of result!.clauses) {
        expect(clause.terms.length).toBeGreaterThan(0);
        for (const term of clause.terms) {
          expect(term.tokens.length).toBeGreaterThan(0);
          expect(term.words).toHaveLength(term.tokens.length);
          for (const token of term.tokens) expect(token).toMatch(/^[\p{L}\p{N}]{3,84}$/u);
        }
      }
    }
  });
});
