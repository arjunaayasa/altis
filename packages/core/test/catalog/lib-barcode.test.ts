import { describe, expect, it } from 'vitest';
import { barcodeProblem, normalizeBarcode } from '../../src/catalog/lib/index.js';

// Spec §3.4: remove CR/LF/TAB, trim characters <= 0x20 and 0x7F at both ends, collapse each inner
// run of spaces to one space, upper-case ASCII. Valid: 0x20-0x7E, length 3-64, and not a valid ISBN-13 (978/979).

describe('normalizeBarcode', () => {
  it('follows the normalisation examples of spec §3.4', () => {
    expect(normalizeBarcode(' m0001\r\n')).toBe('M0001');
    expect(normalizeBarcode('b 00  12')).toBe('B 00 12');
    expect(normalizeBarcode(' b001\t')).toBe('B001');
  });

  it('pins decision P2-08: an inner run of spaces collapses to one and is not removed', () => {
    expect(normalizeBarcode(' b001\r\n')).toBe(normalizeBarcode('B001'));
    expect(normalizeBarcode('b 001')).toBe('B 001');
    expect(normalizeBarcode('b 001')).not.toBe(normalizeBarcode('B001'));
  });

  it('removes CR, LF and TAB anywhere, and trims control characters and DEL at both ends', () => {
    expect(normalizeBarcode('B0\r\n01')).toBe('B001');
    expect(normalizeBarcode('B0\t01')).toBe('B001');
    expect(normalizeBarcode('\u0000\u007f b001 \u001f\u007f')).toBe('B001');
    expect(normalizeBarcode('   ')).toBe('');
  });

  it('upper-cases ASCII only and leaves other characters for barcodeProblem', () => {
    expect(normalizeBarcode('bé0')).toBe('Bé0');
    expect(normalizeBarcode('b\u000b01')).toBe('B\u000b01');
    expect(normalizeBarcode('a-z_09')).toBe('A-Z_09');
  });
});

describe('barcodeProblem', () => {
  it('refuses a valid ISBN-13 starting 978/979', () => {
    expect(barcodeProblem('9786020332956')).toBe('isbn_not_barcode');
    expect(barcodeProblem('9790000000001')).toBe('isbn_not_barcode');
    // A wrong check digit is not an ISBN, so it may be a barcode.
    expect(barcodeProblem('9786020332957')).toBeNull();
  });

  it('checks the length 3-64', () => {
    expect(barcodeProblem('AB')).toBe('length');
    expect(barcodeProblem('')).toBe('length');
    expect(barcodeProblem('ABC')).toBeNull();
    expect(barcodeProblem('A'.repeat(64))).toBeNull();
    expect(barcodeProblem('A'.repeat(65))).toBe('length');
  });

  it('checks the characters 0x20-0x7E', () => {
    expect(barcodeProblem('Bé0')).toBe('charset');
    expect(barcodeProblem('B\u000b01')).toBe('charset');
    expect(barcodeProblem('B\u007f01')).toBe('charset');
    expect(barcodeProblem('B 00 12')).toBeNull();
    expect(barcodeProblem('!~/"')).toBeNull();
  });
});
