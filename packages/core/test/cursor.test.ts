import { describe, expect, it } from 'vitest';
import { formatCursor, parseCursor } from '../src/events/cursor.js';

// The event cursor `<dataEpoch>.<seq>` (spec §10.6): what GET events hands out and takes back.

describe('formatCursor', () => {
  it('writes "<epoch>.<seq>"', () => {
    expect(formatCursor(3, 42)).toBe('3.42');
    expect(formatCursor(0, 0)).toBe('0.0');
    expect(formatCursor(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(`${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}`);
  });

  it('refuses a part that is not a safe integer of at least 0', () => {
    for (const [epoch, seq] of [
      [-1, 0],
      [0, -1],
      [1.5, 0],
      [0, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [Number.MAX_SAFE_INTEGER + 1, 0],
    ] as const) {
      expect(() => formatCursor(epoch, seq)).toThrow(TypeError);
    }
  });
});

describe('parseCursor', () => {
  it('reads "<epoch>.<seq>"', () => {
    expect(parseCursor('3.42')).toEqual({ epoch: 3, seq: 42 });
    expect(parseCursor('0.0')).toEqual({ epoch: 0, seq: 0 });
    expect(parseCursor(formatCursor(7, 123_456_789))).toEqual({ epoch: 7, seq: 123_456_789 });
  });

  it('is null for anything else', () => {
    for (const s of [
      '3',
      'a.1',
      '-1.2',
      '3.1.2',
      '',
      '.',
      '3.',
      '.3',
      ' 3.4',
      '3.4 ',
      '3.4\n',
      '+3.4',
      '03.4',
      '3.04',
      '3.4e2',
      '0x3.4',
      '٣.٤',
      `${Number.MAX_SAFE_INTEGER + 1}.1`,
      `1.${'9'.repeat(400)}`,
    ]) {
      expect(parseCursor(s), JSON.stringify(s)).toBeNull();
    }
  });

  it('is null for a value that is not a string', () => {
    for (const v of [null, undefined, 3, { epoch: 3, seq: 4 }]) {
      expect(parseCursor(v as unknown as string)).toBeNull();
    }
  });
});
