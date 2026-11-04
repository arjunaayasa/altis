import { describe, expect, it } from 'vitest';
import {
  identifierQuery,
  isValidIsbn13Barcode,
  normalizeDoi,
  parseIsbn,
  parseIssn,
  splitIdentifierText,
} from '../../src/catalog/lib/index.js';

// Spec §3.2: ISBN-10 and ISBN-13 (with or without hyphens, `X` only as the ISBN-10 check digit) normalise to a 13-digit
// value_key; value_display keeps the input form; a wrong check digit is kept with is_valid = 0. ISSN: 8 characters,
// check digit mod 11.

describe('parseIsbn', () => {
  it('maps a valid ISBN-10 to its 978 key', () => {
    expect(parseIsbn('0-306-40615-2')).toEqual({ key: '9780306406157', valid: true, display: '0-306-40615-2' });
  });

  it('maps an ISBN-10 shape with a wrong check digit to 978 + 9 digits + a new check digit, valid: false', () => {
    expect(parseIsbn('979-1234-56-7')).toEqual({ key: '9789791234566', valid: false, display: '979-1234-56-7' });
  });

  it('accepts a valid ISBN-13', () => {
    expect(parseIsbn('978-602-03-3295-6')).toEqual({ key: '9786020332956', valid: true, display: '978-602-03-3295-6' });
    expect(parseIsbn('9786020332956')?.valid).toBe(true);
  });

  it('keeps an ISBN-13 with a wrong check digit as entered, valid: false', () => {
    expect(parseIsbn('978-602-03-3295-7')).toEqual({ key: '9786020332957', valid: false, display: '978-602-03-3295-7' });
  });

  it('accepts X (either case) only as the ISBN-10 check digit', () => {
    expect(parseIsbn('0-8044-2957-X')).toEqual({ key: '9780804429573', valid: true, display: '0-8044-2957-X' });
    expect(parseIsbn('080442957x')).toEqual({ key: '9780804429573', valid: true, display: '080442957X' });
    expect(parseIsbn('08044X9571')).toBeNull();
    expect(parseIsbn('978602033295X')).toBeNull();
  });

  it('allows spaces and hyphens, and trims the display', () => {
    expect(parseIsbn('  978 602 03 3295 6 ')).toEqual({ key: '9786020332956', valid: true, display: '978 602 03 3295 6' });
    expect(parseIsbn('978\u{2010}602\u{2010}03\u{2010}3295\u{2010}6')?.key).toBe('9786020332956');
  });

  it('refuses what is not ISBN-shaped', () => {
    expect(parseIsbn('')).toBeNull();
    expect(parseIsbn('abc')).toBeNull();
    expect(parseIsbn('12345')).toBeNull();
    expect(parseIsbn('97860203329561')).toBeNull();
    // 13 digits that do not start 978/979 are an EAN, not an ISBN.
    expect(parseIsbn('1234567890128')).toBeNull();
    expect(parseIsbn('ISBN 9786020332956')).toBeNull();
  });
});

describe('parseIssn', () => {
  it('checks the mod 11 check digit', () => {
    expect(parseIssn('0378-5955')).toEqual({ key: '03785955', valid: true, display: '0378-5955' });
    expect(parseIssn('0378-5954')).toEqual({ key: '03785954', valid: false, display: '0378-5954' });
  });

  it('upper-cases an X check digit in the key', () => {
    expect(parseIssn('2434-561x')).toEqual({ key: '2434561X', valid: true, display: '2434-561X' });
    expect(parseIssn('24345611')?.valid).toBe(false);
  });

  it('refuses what is not ISSN-shaped', () => {
    expect(parseIssn('')).toBeNull();
    expect(parseIssn('0378-595')).toBeNull();
    expect(parseIssn('03X8-5955')).toBeNull();
    expect(parseIssn('0378-59555')).toBeNull();
  });
});

describe('isValidIsbn13Barcode', () => {
  it('is true only for a valid 13-digit ISBN starting 978/979', () => {
    expect(isValidIsbn13Barcode('9786020332956')).toBe(true);
    expect(isValidIsbn13Barcode('9790000000001')).toBe(true);
    expect(isValidIsbn13Barcode('9786020332957')).toBe(false);
    expect(isValidIsbn13Barcode('9771234567003')).toBe(false);
    expect(isValidIsbn13Barcode('978-602-03-3295-6')).toBe(false);
    expect(isValidIsbn13Barcode('0306406152')).toBe(false);
    expect(isValidIsbn13Barcode('B0001')).toBe(false);
  });
});

describe('splitIdentifierText', () => {
  it('splits mixed text, classifies each part and keeps a bracketed note as the qualifier', () => {
    expect(splitIdentifierText('979-1234-56-7 (jil. 1); 0123-4567')).toEqual([
      { type: 'isbn', value: '979-1234-56-7', key: '9789791234566', valid: false, qualifier: 'jil. 1' },
      { type: 'issn', value: '0123-4567', key: '01234567', valid: false, qualifier: null },
    ]);
  });

  it('splits on `;`, `,` and `/`, and drops an ISBN/ISSN label', () => {
    expect(splitIdentifierText('ISBN 978-602-03-3295-6, 0-306-40615-2 / ISSN: 2434-561X')).toEqual([
      { type: 'isbn', value: '978-602-03-3295-6', key: '9786020332956', valid: true, qualifier: null },
      { type: 'isbn', value: '0-306-40615-2', key: '9780306406157', valid: true, qualifier: null },
      { type: 'issn', value: '2434-561X', key: '2434561X', valid: true, qualifier: null },
    ]);
  });

  it('does not split inside brackets', () => {
    expect(splitIdentifierText('978-602-03-3295-6 (jil. 1, cet. 2) [pbk.]')).toEqual([
      { type: 'isbn', value: '978-602-03-3295-6', key: '9786020332956', valid: true, qualifier: 'jil. 1, cet. 2; pbk.' },
    ]);
  });

  it('puts the rest of the text after the identifier into the qualifier', () => {
    expect(splitIdentifierText('9786020332956 pbk.')).toEqual([
      { type: 'isbn', value: '9786020332956', key: '9786020332956', valid: true, qualifier: 'pbk.' },
    ]);
  });

  it('keeps unrecognised text as `other` and skips empty parts', () => {
    expect(splitIdentifierText('lihat jilid 2;; ')).toEqual([
      { type: 'other', value: 'lihat jilid 2', key: null, valid: false, qualifier: null },
    ]);
    expect(splitIdentifierText('')).toEqual([]);
    expect(splitIdentifierText(' ; , / ')).toEqual([]);
  });
});

describe('normalizeDoi', () => {
  it('strips the doi: and resolver prefixes and lower-cases', () => {
    expect(normalizeDoi('10.1000/XYZ123')).toBe('10.1000/xyz123');
    expect(normalizeDoi('doi:10.1000/abc')).toBe('10.1000/abc');
    expect(normalizeDoi(' DOI: 10.1000/abc ')).toBe('10.1000/abc');
    expect(normalizeDoi('https://doi.org/10.1000/ABC')).toBe('10.1000/abc');
    expect(normalizeDoi('http://dx.doi.org/10.1000%2Fabc')).toBe('10.1000/abc');
  });

  it('refuses what is not a DOI', () => {
    expect(normalizeDoi('')).toBeNull();
    expect(normalizeDoi('not a doi')).toBeNull();
    expect(normalizeDoi('10.12/abc')).toBeNull();
    expect(normalizeDoi('10.1000/')).toBeNull();
    expect(normalizeDoi('10.1000/a b')).toBeNull();
    expect(normalizeDoi('https://doi.org/10.1000/%E0%A4%A')).toBeNull();
    expect(normalizeDoi(`10.1000/${'a'.repeat(200)}`)).toBeNull();
  });
});

describe('identifierQuery', () => {
  it('recognises an ISBN or ISSN shaped query, with or without hyphens', () => {
    expect(identifierQuery('978-602-03-3295-6')).toEqual({ type: 'isbn', key: '9786020332956' });
    expect(identifierQuery(' 0306406152 ')).toEqual({ type: 'isbn', key: '9780306406157' });
    expect(identifierQuery('0378-5955')).toEqual({ type: 'issn', key: '03785955' });
    expect(identifierQuery('isbn:979-1234-56-7')).toEqual({ type: 'isbn', key: '9789791234566' });
    expect(identifierQuery('ISSN 2434-561x')).toEqual({ type: 'issn', key: '2434561X' });
    expect(identifierQuery('ISBN-13: 978-602-03-3295-6')).toEqual({ type: 'isbn', key: '9786020332956' });
  });

  it('answers null for anything else', () => {
    expect(identifierQuery('laskar pelangi')).toBeNull();
    expect(identifierQuery('2020')).toBeNull();
    expect(identifierQuery('')).toBeNull();
    expect(identifierQuery('issn:9786020332956')).toBeNull();
    expect(identifierQuery('isbn:0378-5955')).toBeNull();
    expect(identifierQuery('isbn')).toBeNull();
    expect(identifierQuery('978-602-03-3295-6 laskar')).toBeNull();
  });
});
