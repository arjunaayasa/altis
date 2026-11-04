import { describe, expect, it } from 'vitest';
import { vocabularyWord } from '../../src/search/terms.js';
import { INNODB_STOPWORDS, SEARCH_ESCAPED_MAX, SEARCH_TOKEN_MAX, decodeSearchToken, encodeSearchToken, searchPrefixToken, searchTokenize } from '../../src/search/tokenize.js';

// Phase 2 spec §4.2: one tokenizer for the index and the query. NFKD, diacritics stripped, lower case; split on what is
// not a letter or digit; ISBN/ISSN in the text also as their 13/8-character key; tokens shorter than 3 characters and
// the 36 InnoDB default stopwords prefixed `zq` on every dialect (D2-08); tokens cut at 84 characters.

describe('INNODB_STOPWORDS', () => {
  it('is the 36 rows of the InnoDB default stopword table, in its order (`the` is listed twice there)', () => {
    expect(INNODB_STOPWORDS).toHaveLength(36);
    expect(INNODB_STOPWORDS.slice(0, 5)).toEqual(['a', 'about', 'an', 'are', 'as']);
    expect(INNODB_STOPWORDS.slice(-3)).toEqual(['und', 'the', 'www']);
    expect(new Set(INNODB_STOPWORDS).size).toBe(35);
    expect(Object.isFrozen(INNODB_STOPWORDS)).toBe(true);
  });
});

describe('searchTokenize', () => {
  it('prefixes short tokens and stopwords with zq; `and` is no InnoDB stopword', () => {
    expect(searchTokenize('AI and C++ for The People')).toEqual(['zqai', 'and', 'zqc', 'zqfor', 'zqthe', 'people']);
  });

  it('strips diacritics after NFKD and lower-cases', () => {
    expect(searchTokenize('Ñandú')).toEqual(['nandu']);
    expect(searchTokenize('CAFÉ  Crème-brûlée')).toEqual(['cafe', 'creme', 'brulee']);
    // Full-width forms fold (NFKD); Latin letters NFKD keeps whole fold as in title_key.
    expect(searchTokenize('\u{FF21}\u{FF22}\u{FF23} Straße Ærø Łódź')).toEqual(['abc', 'strasse', 'aero', 'lodz']);
  });

  it('removes apostrophes inside a word, as the title key does', () => {
    expect(searchTokenize("Tafsir Al-Qur'an Jum\u{2019}at")).toEqual(['tafsir', 'zqal', 'quran', 'jumat']);
  });

  it('splits on everything that is not a letter or a digit', () => {
    expect(searchTokenize('899.221 HIR l / e-book; (2010)')).toEqual(['899', '221', 'hir', 'zql', 'zqe', 'book', '2010']);
    expect(searchTokenize('')).toEqual([]);
    expect(searchTokenize(' \t\n—…')).toEqual([]);
  });

  it('a run of letters of a script without spaces is one token (an accepted limitation), written in base 36', () => {
    expect(searchTokenize('東京大学 図書館')).toEqual(['zqx0kfl0fjg0hlz0i1y', 'zqx0h6b0kc80u94']);
    expect(searchTokenize('東京大学 図書館').map(decodeSearchToken)).toEqual(['東京大学', '図書館']);
  });

  it('an ISBN in the text also yields its 13-digit key, right after its parts', () => {
    expect(searchTokenize('ISBN 978-602-03-3295-6')).toEqual(['isbn', '978', '602', 'zq03', '3295', 'zq6', '9786020332956']);
    // An ISBN-10 (with its check character X) yields the 978 key; one already written as 13 digits is not repeated.
    expect(searchTokenize('0-8044-2957-X')).toContain('9780804429573');
    expect(searchTokenize('9786020332956')).toEqual(['9786020332956']);
    // Spaces as separators, and an ISBN after other numbers.
    expect(searchTokenize('cet. 2010 978 602 03 3295 6')).toContain('9786020332956');
    // A wrong check digit: no key from free text (the record's identifiers carry their own key).
    expect(searchTokenize('978-602-03-3295-7')).not.toContain('9786020332957');
  });

  it('an ISSN (four digits, a hyphen, four characters) also yields its 8-character key', () => {
    expect(searchTokenize('ISSN 0317-8471')).toEqual(['issn', '0317', '8471', '03178471']);
    expect(searchTokenize('ISSN 2049-3630 dan 0002-936X')).toEqual(expect.arrayContaining(['20493630', '0002936x']));
    expect(searchTokenize('0317-8472')).not.toContain('03178472'); // wrong check character
  });

  it('cuts a token longer than 84 characters to 84 (code points)', () => {
    expect(SEARCH_TOKEN_MAX).toBe(84);
    expect(searchTokenize('a'.repeat(85))).toEqual(['a'.repeat(84)]);
    const astral = '\u{1D49C}'.repeat(90);
    const [token] = searchTokenize(astral);
    expect(token === undefined ? 0 : [...token].length).toBe(84);
  });

  it('never throws on odd input (lone surrogates, controls)', () => {
    expect(() => searchTokenize('\u{D800}x\u{0000}y\u{FFFF}')).not.toThrow();
    expect(searchTokenize('abc\u{0000}def')).toEqual(['abc', 'def']);
  });
});

describe('encodeSearchToken', () => {
  it('prefixes a token shorter than 3, a stopword, and a token that already starts with zq (so the encoding stays one-to-one)', () => {
    expect(encodeSearchToken('ai')).toBe('zqai');
    expect(encodeSearchToken('c')).toBe('zqc');
    expect(encodeSearchToken('the')).toBe('zqthe');
    expect(encodeSearchToken('about')).toBe('zqabout');
    expect(encodeSearchToken('and')).toBe('and');
    expect(encodeSearchToken('pendidikan')).toBe('pendidikan');
    expect(encodeSearchToken('zqai')).toBe('zqzqai');
    expect(encodeSearchToken('zqx')).not.toBe(encodeSearchToken('x'));
  });

  it('keeps the result within 84 characters', () => {
    expect(encodeSearchToken(`zq${'b'.repeat(90)}`)).toHaveLength(84);
  });

  // Task 39 (K8 on every engine): InnoDB, PostgreSQL and FTS5 parse the token text again, each its own way.
  it('writes a token with any character outside a-z0-9 as zqx and 4 base-36 digits per code point, at most 20 of them', () => {
    expect(encodeSearchToken('мир')).toBe('zqx00u400u000u8');
    // A short word of another script is written so too, never prefixed as a short word.
    expect(encodeSearchToken('東京')).toBe('zqx0kfl0fjg');
    // Beyond the BMP (InnoDB makes such a character a separator).
    expect(encodeSearchToken('𠮷野家')).toBe('zqx2vg70ssu0i46');
    for (const word of ['ꦗꦮꦏꦤ', 'ᮞᮔᮓᮛ', 'ᯅᯖᯂ', 'مكتبة', '١٩٤٥٢', 'ひらがな', 'ヒラガナ', 'βιβλιοθηκη', 'abc東京']) {
      const token = encodeSearchToken(word);
      expect(token).toMatch(/^zqx(?:[0-9a-z]{4})+$/);
      expect(decodeSearchToken(token)).toBe(word);
    }
    const long = 'ж'.repeat(SEARCH_ESCAPED_MAX + 5);
    expect(SEARCH_ESCAPED_MAX).toBe(20);
    expect(encodeSearchToken(long)).toHaveLength(84 - 1);
    expect(decodeSearchToken(encodeSearchToken(long))).toBe('ж'.repeat(20));
  });

  it('prefixes a token PostgreSQL would cut as a float (digits, e, a digit)', () => {
    expect(encodeSearchToken('2e10x')).toBe('zq2e10x');
    expect(encodeSearchToken('1e05')).toBe('zq1e05');
    expect(encodeSearchToken('599e')).toBe('599e');
    expect(encodeSearchToken('x1e5')).toBe('x1e5');
    expect(searchTokenize('Reaktor 2e10x')).toEqual(['reaktor', 'zq2e10x']);
  });

  it('stays one-to-one: every encoded token decodes to its word, and no two words share a token', () => {
    const words = ['x', 'xy', 'xyz', 'ai', 'the', 'about', 'zq', 'zqx', 'zqai', 'zqx0kfl', 'pendidikan', '2e10x', '978602', 'мир', 'ж', '東京', 'ꦗꦮ'];
    const tokens = words.map(encodeSearchToken);
    expect(new Set(tokens).size).toBe(words.length);
    expect(tokens.map(decodeSearchToken)).toEqual(words);
    for (const t of tokens) expect(t).toMatch(/^[0-9a-z]{1,84}$/);
    expect(decodeSearchToken('Laskar')).toBeNull();
    expect(decodeSearchToken('zqx16o0')).toBeNull(); // 0xd800, a lone surrogate
  });
});

describe('searchPrefixToken', () => {
  it('is the stored form every token of a longer word begins with', () => {
    for (const [prefix, word] of [
      ['библио', 'библиотека'],
      ['ꦗꦮ', 'ꦗꦮꦏꦤ'],
      ['pend', 'pendidikan'],
      ['zqa', 'zqalpha'],
      ['2e1', '2e10x'],
    ] as const) {
      expect(encodeSearchToken(word).startsWith(searchPrefixToken(prefix))).toBe(true);
    }
    // Plain digits stay plain: the float-like words they begin are matched by sql.ts through a second form.
    expect(searchPrefixToken('123')).toBe('123');
  });
});

describe('vocabularyWord (terms.ts)', () => {
  it('decodes a token to the word the spelling correction compares, letters only and 3 or more of them', () => {
    expect(vocabularyWord('pendidikan')).toBe('pendidikan');
    expect(vocabularyWord('zqthe')).toBe('the');
    expect(vocabularyWord(encodeSearchToken('библиотека'))).toBe('библиотека');
    expect(vocabularyWord(encodeSearchToken('東京'))).toBeNull(); // two letters
    expect(vocabularyWord(encodeSearchToken('١٩٤٥٢'))).toBeNull(); // digits
    expect(vocabularyWord('zq2e10x')).toBeNull();
    expect(vocabularyWord('zqx16o0')).toBeNull();
  });
});
