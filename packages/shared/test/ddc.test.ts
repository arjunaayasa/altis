import { describe, expect, it } from 'vitest';
import { DDC_MAINS, compareDdcRowKeys, ddcClassOf, ddcDivisionKey, ddcRowKind, foldByDdc, type DdcRowKey } from '../src/ddc.js';
import * as root from '../src/index.js';

// The DDC reader of the reports: the first token of the classification (or, when it is empty, of the call number) gives
// the main class and the division. `2X…`, the Indonesian expansion of the 200s for Islam, is a class of its own and
// never counted in 200; anything that is not three leading digits is "Lainnya" (NON), with its token kept.

describe('ddcClassOf', () => {
  it('2X in either case is its own class, never 200', () => {
    expect(ddcClassOf('2X4.3', null)).toEqual({ main: '2X', division: null, token: '2X4.3' });
    expect(ddcClassOf('2x7 ABD', null)).toEqual({ main: '2X', division: null, token: '2x7' });
  });

  it('three leading digits give the main class and the division', () => {
    expect(ddcClassOf('297', null)).toEqual({ main: '200', division: '290', token: '297' });
    expect(ddcClassOf('899.221 HIR l', null)).toEqual({ main: '800', division: '890', token: '899.221' });
    expect(ddcClassOf('  005.133  ', null)).toEqual({ main: '000', division: '000', token: '005.133' });
  });

  it('an empty classification falls back to the first number of the call number, past letter-only tokens', () => {
    expect(ddcClassOf('', 'R 030 ENS e')).toEqual({ main: '000', division: '030', token: '030' });
    expect(ddcClassOf(null, 'REF 2X1.2 ABC')).toEqual({ main: '2X', division: null, token: '2X1.2' });
    expect(ddcClassOf('   ', 'FIK 899.221 HIR l')).toEqual({ main: '800', division: '890', token: '899.221' });
  });

  it('a call number without such a token, or nothing at all, is NON with an empty token', () => {
    expect(ddcClassOf(null, 'FIK HIR l')).toEqual({ main: 'NON', division: null, token: '' });
    expect(ddcClassOf(null, null)).toEqual({ main: 'NON', division: null, token: '' });
    expect(ddcClassOf('', 'PROG/2021 X')).toEqual({ main: 'NON', division: null, token: '' });
  });

  it('anything else is NON, its token kept for the breakdown', () => {
    expect(ddcClassOf('PROG/2021', null)).toEqual({ main: 'NON', division: null, token: 'PROG/2021' });
    expect(ddcClassOf('89', null)).toEqual({ main: 'NON', division: null, token: '89' });
    expect(ddcClassOf('R 030', 'R 030')).toEqual({ main: 'NON', division: null, token: 'R' });
  });

  it('DDC_MAINS lists the classes in print order', () => {
    expect([...DDC_MAINS]).toEqual(['000', '100', '200', '300', '400', '500', '600', '700', '800', '900', '2X', 'NON']);
    expect(Object.isFrozen(DDC_MAINS)).toBe(true);
  });
});

describe('foldByDdc', () => {
  const groups = [
    { classification: '2X4.3', callNumber: null, value: 1 },
    { classification: '2X4.3', callNumber: null, value: 1 },
    { classification: '297', callNumber: null, value: 1 },
    { classification: '899.221', callNumber: null, value: 1 },
    { classification: '', callNumber: 'R 030 ENS e', value: 1 },
    { classification: 'PROG/2021', callNumber: null, value: 1 },
  ];
  const sum = (acc: number | undefined, v: number): number => (acc ?? 0) + v;

  it('adds each group under its main class, its division and its NON token', () => {
    const folded = foldByDdc(groups, sum, { divisions: true, nonTokens: true });
    expect(Object.fromEntries(folded)).toEqual({
      '2X': 2,
      '200': 1,
      '290': 1,
      '800': 1,
      '890': 1,
      '000': 1,
      '030': 1,
      NON: 1,
      'NON:PROG/2021': 1,
    });
  });

  it('without divisions or tokens only the main classes that received a group appear', () => {
    const folded = foldByDdc(groups, sum, { divisions: false, nonTokens: false });
    expect(Object.fromEntries(folded)).toEqual({ '2X': 2, '200': 1, '800': 1, '000': 1, NON: 1 });
  });

  it('the first division of a class has a key of its own, so it is never counted into the class twice', () => {
    const folded = foldByDdc(
      [
        { classification: '801.95', callNumber: null, value: 2 },
        { classification: '813', callNumber: null, value: 3 },
      ],
      sum,
      { divisions: true, nonTokens: false },
    );
    expect(Object.fromEntries(folded)).toEqual({ '800': 5, [ddcDivisionKey('800')]: 2, '810': 3 });
    expect(ddcDivisionKey('800')).not.toBe('800');
    expect(ddcDivisionKey('810')).toBe('810');
  });

  it('folds any value with the given add (here: a set of ids)', () => {
    const folded = foldByDdc(
      [
        { classification: '297', callNumber: null, value: new Set(['a']) },
        { classification: '297.1', callNumber: null, value: new Set(['b']) },
      ],
      (acc: Set<string> | undefined, v: Set<string>) => new Set([...(acc ?? []), ...v]),
      { divisions: false, nonTokens: false },
    );
    expect([...folded.get('200')!].sort()).toEqual(['a', 'b']);
  });
});

describe('compareDdcRowKeys', () => {
  it('orders the main classes as DDC_MAINS, each followed by its divisions, and NON before its tokens', () => {
    expect(['NON:B', '2X', '810', '800', 'NON', '000'].sort(compareDdcRowKeys)).toEqual(['000', '800', '810', '2X', 'NON', 'NON:B']);
    const keys: DdcRowKey[] = ['NON:b', '890', ddcDivisionKey('800'), '900', 'NON:A', '810', '800', 'NON', '2X', '100', '000', '010'];
    expect([...keys].sort(compareDdcRowKeys)).toEqual(['000', '010', '100', '800', ddcDivisionKey('800'), '810', '890', '900', '2X', 'NON', 'NON:A', 'NON:b']);
  });

  it('ddcRowKind names what a key stands for', () => {
    expect(['000', '810', ddcDivisionKey('300'), '2X', 'NON', 'NON:PROG', 'xyz'].map(ddcRowKind)).toEqual([
      'main',
      'division',
      'division',
      '2X',
      'NON',
      'NON_token',
      null,
    ]);
  });
});

describe('the package root', () => {
  it('re-exports the DDC reader', () => {
    expect(root.ddcClassOf).toBe(ddcClassOf);
    expect(root.foldByDdc).toBe(foldByDdc);
    expect(root.compareDdcRowKeys).toBe(compareDdcRowKeys);
    expect(root.DDC_MAINS).toBe(DDC_MAINS);
  });
});
