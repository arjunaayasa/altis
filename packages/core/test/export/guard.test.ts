import { describe, expect, it } from 'vitest';
import { csvCell } from '../../src/export/csv.js';
import { formulaGuard } from '../../src/export/guard.js';

// The formula guard shared by the CSV and the XLSX exporter: a text a spreadsheet would read as a formula (it starts
// with `= + - @`, TAB or CR, or a full-width `＝ ＋ － ＠`) gets a `'` in front, and any other text stays as it is.

describe('formulaGuard', () => {
  it('puts an apostrophe before a formula start', () => {
    expect(formulaGuard('=1+1')).toBe("'=1+1");
    expect(formulaGuard('+1')).toBe("'+1");
    expect(formulaGuard('-3')).toBe("'-3");
    expect(formulaGuard('@x')).toBe("'@x");
    expect(formulaGuard('\tx')).toBe("'\tx");
    expect(formulaGuard('\rx')).toBe("'\rx");
  });

  it('guards the full-width forms as well', () => {
    expect(formulaGuard('＝1')).toBe("'＝1");
    expect(formulaGuard('＋1')).toBe("'＋1");
    expect(formulaGuard('－1')).toBe("'－1");
    expect(formulaGuard('＠x')).toBe("'＠x");
  });

  it('leaves every other text alone', () => {
    expect(formulaGuard('Budi')).toBe('Budi');
    expect(formulaGuard('')).toBe('');
    expect(formulaGuard(' =1')).toBe(' =1');
    expect(formulaGuard('a=1')).toBe('a=1');
    expect(formulaGuard("'=1")).toBe("'=1");
    expect(formulaGuard('تفسير الجلالين')).toBe('تفسير الجلالين');
    expect(formulaGuard('\n=1')).toBe('\n=1');
  });
});

describe('csvCell keeps its output on top of the shared guard', () => {
  it('writes the cells of the earlier CSV exports exactly as before', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tx')).toBe(`"'\tx"`);
    expect(csvCell('\rx')).toBe(`"'\rx"`);
    expect(csvCell('＝SUM(A1)')).toBe(`"'＝SUM(A1)"`);
    expect(csvCell('=" "')).toBe(`"'="" """`);
    expect(csvCell('a"b')).toBe(`"a""b"`);
    expect(csvCell(' =1')).toBe(`" =1"`);
    expect(csvCell(null)).toBe(`""`);
    expect(csvCell(42)).toBe(`"42"`);
    expect(csvCell(-5)).toBe(`"'-5"`);
    expect(csvCell({ usernameKey: '=HYPERLINK(1)' })).toBe(`"{""usernameKey"":""=HYPERLINK(1)""}"`);
  });

  it('quotes exactly what formulaGuard returns', () => {
    for (const text of ['=1', '+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠', 'Budi', '', 'a"b', '"=x"', 'تفسير']) {
      expect(csvCell(text)).toBe(`"${formulaGuard(text).replace(/"/g, '""')}"`);
    }
  });
});
