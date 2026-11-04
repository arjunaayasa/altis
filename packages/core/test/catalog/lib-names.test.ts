import { describe, expect, it } from 'vitest';
import { uninvertName } from '../../src/catalog/lib/index.js';

// Spec §2.1: personal names are stored in the MARC inverted form when there is a family name; a single name as is.

describe('uninvertName', () => {
  it('puts the family name last', () => {
    expect(uninvertName('Toer, Pramoedya Ananta')).toBe('Pramoedya Ananta Toer');
    expect(uninvertName('Hirata, Andrea')).toBe('Andrea Hirata');
  });

  it('keeps a single name as is, trimmed', () => {
    expect(uninvertName('Soekarno')).toBe('Soekarno');
    expect(uninvertName('  Hamka  ')).toBe('Hamka');
    expect(uninvertName('')).toBe('');
  });

  it('keeps a suffix after the given name and drops trailing ISBD punctuation', () => {
    expect(uninvertName('King, Martin Luther, Jr.')).toBe('Martin Luther King Jr.');
    expect(uninvertName('Toer, Pramoedya Ananta,')).toBe('Pramoedya Ananta Toer');
    expect(uninvertName('Smith, J. :')).toBe('J. Smith');
    expect(uninvertName('Toer,')).toBe('Toer');
    expect(uninvertName(',Toer')).toBe('Toer');
  });

  it('collapses spaces', () => {
    expect(uninvertName('Toer ,   Pramoedya   Ananta')).toBe('Pramoedya Ananta Toer');
  });
});
