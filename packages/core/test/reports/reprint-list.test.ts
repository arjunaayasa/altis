import { describe, expect, it } from 'vitest';
import { slimsCodeOfNote } from '../../src/reports/members/reprint-list.js';

// The reprint list's "code in SLiMS" of a copy whose code the migration replaced: what the copy's note keeps of it.

describe('slimsCodeOfNote', () => {
  it('reads the SLiMS code without the note prefix', () => {
    expect(slimsCodeOfNote('SLiMS: B–0013')).toBe('B–0013');
  });

  it('reads the code after the note of an unknown SLiMS status', () => {
    expect(slimsCodeOfNote('SLiMS: Rusak berat (RB); SLiMS: 9780000000002')).toBe('9780000000002');
  });

  it('is empty when the note keeps no code', () => {
    expect(slimsCodeOfNote(null)).toBe('');
    expect(slimsCodeOfNote('')).toBe('');
    expect(slimsCodeOfNote('Dipindah dari rak lama')).toBe('');
  });
});
