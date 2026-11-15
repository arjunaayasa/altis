import { qrMatrix } from '@altis/shared';
import qrcode from 'qrcode-generator';
import { describe, expect, it } from 'vitest';

// The member card's QR encoder (@altis/shared, written for ALTIS without a dependency) against qrcode-generator, the
// library the admin already uses for 2FA enrolment: for the same text (UTF-8, byte mode, level M, smallest version)
// both must draw the same symbol, module for module.

/** The text as UTF-8 bytes, one character per byte: what the library's byte mode encodes. */
function utf8Binary(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte);
  return out;
}

function reference(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(utf8Binary(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, row) => Array.from({ length: n }, (_, col) => qr.isDark(row, col)));
}

/** Fifty inputs: member numbers of every shape, lengths across versions 1-10, and non-ASCII text. */
const INPUTS: string[] = [
  'A',
  '1',
  'B001',
  'B 001',
  '00123',
  'SISWA-2026-0001',
  'GURU/2025/017',
  'M2',
  '2026.07.0001',
  'X'.repeat(14),
  'X'.repeat(15),
  'Anggota-Ñandú',
  'ÁÉÍÓÚ',
  '漢字テスト',
  'abc'.repeat(8),
  'MIG' + '9'.repeat(20),
  'b001-n',
  ...Array.from({ length: 23 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${String(i * 7919).padStart(6, '0')}`),
  'Z'.repeat(26),
  'Z'.repeat(27),
  'Q'.repeat(42),
  'Q'.repeat(62),
  'Q'.repeat(64),
  'q'.repeat(84),
  'w'.repeat(106),
  'e'.repeat(122),
  'r'.repeat(152),
  't'.repeat(200),
];

describe('qrMatrix (the member card QR encoder)', () => {
  it('has fifty inputs', () => {
    expect(INPUTS).toHaveLength(50);
  });

  it.each(INPUTS.map((text) => [text.length > 20 ? `${text.slice(0, 20)}… (${text.length})` : text, text]))('draws %s as qrcode-generator does', (_label, text) => {
    const mine = qrMatrix(text);
    const theirs = reference(text);
    expect(mine.size).toBe(theirs.length);
    expect(mine.version).toBe((theirs.length - 17) / 4);
    expect(mine.dark).toEqual(theirs);
  });

  it('refuses a text past version 10', () => {
    expect(() => qrMatrix('x'.repeat(214))).toThrow(RangeError);
    expect(qrMatrix('x'.repeat(213)).version).toBe(10);
  });
});
