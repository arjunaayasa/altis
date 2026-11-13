import { describe, expect, it } from 'vitest';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { catalogueCode } from '../../src/accreditation/scoring/score.js';
import type { AccredInstrument } from '../../src/accreditation/types.js';

// Each indicator has a concept key (the upper secondary numbering, `SCH-L8`) and the number its own decree prints. The
// primary and lower secondary instruments have no plagiarism item, so their service items 8 to 14 are numbered 7 to 13
// and `SCH-L7` does not exist there; the upper secondary instrument numbers every item as its concept key.

const table = (id: string): [string, string][] =>
  (instrumentById(id) as AccredInstrument).components.flatMap((c) => c.indicators.map((i): [string, string] => [catalogueCode(i), i.officialNo]));

const range = (prefix: string, from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, k) => `${prefix}${from + k}`);

const SAME = [...range('K', 1, 8), ...range('SP', 1, 7)];
const AFTER = [...range('T', 1, 5), ...range('F', 1, 4), ...range('G', 1, 4)];
const identity = (codes: string[]): [string, string][] => codes.map((c) => [`SCH-${c}`, c]);

describe('official numbers', () => {
  for (const id of ['sch-sd-2025', 'sch-smp-2025']) {
    it(`${id}: SCH-L1 to SCH-L6 keep their numbers, SCH-L8 to SCH-L14 print L7 to L13, and there is no SCH-L7`, () => {
      expect(table(id)).toEqual([
        ...identity(SAME),
        ...identity(range('L', 1, 6)),
        ['SCH-L8', 'L7'],
        ['SCH-L9', 'L8'],
        ['SCH-L10', 'L9'],
        ['SCH-L11', 'L10'],
        ['SCH-L12', 'L11'],
        ['SCH-L13', 'L12'],
        ['SCH-L14', 'L13'],
        ...identity(AFTER),
      ]);
      expect(table(id).map(([code]) => code)).not.toContain('SCH-L7');
    });
  }

  it('sch-sma-2025: every indicator prints its concept key', () => {
    expect(table('sch-sma-2025')).toEqual(identity([...SAME, ...range('L', 1, 14), ...AFTER]));
  });
});
