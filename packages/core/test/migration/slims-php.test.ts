import { describe, expect, it } from 'vitest';
import { phpUnserialize } from '../../src/migration/slims/source/index.js';

// PHP's serialize() format as SLiMS stores it (spec §11.5 step 4): arrays, strings (`s:<n>` counts UTF-8 bytes),
// integers, floats, booleans and null; a broken payload gives back the quoted strings it holds.

describe('phpUnserialize', () => {
  it('reads a list of strings, counting the length in UTF-8 bytes', () => {
    expect(phpUnserialize('a:1:{i:0;s:5:"Café";}')).toEqual({ ok: true, value: ['Café'] });
  });

  it('gives back the quoted strings of a truncated payload', () => {
    expect(phpUnserialize('a:1:{i:0;s:5:"Café')).toEqual({ ok: false, strings: ['Café'] });
    expect(phpUnserialize('a:2:{i:0;s:3:"one";i:1;s:3:"two')).toEqual({ ok: false, strings: ['one', 'two'] });
    expect(phpUnserialize('a:2:{i:0;s:3:"one";i:1;s:3:"tw')).toEqual({ ok: false, strings: ['one', 'tw'] });
  });

  it('reads every scalar type', () => {
    expect(phpUnserialize('i:42;')).toEqual({ ok: true, value: 42 });
    expect(phpUnserialize('i:-7;')).toEqual({ ok: true, value: -7 });
    expect(phpUnserialize('d:1.5;')).toEqual({ ok: true, value: 1.5 });
    expect(phpUnserialize('d:-2.5E-3;')).toEqual({ ok: true, value: -0.0025 });
    expect(phpUnserialize('d:INF;')).toEqual({ ok: true, value: Infinity });
    expect(phpUnserialize('b:1;')).toEqual({ ok: true, value: true });
    expect(phpUnserialize('b:0;')).toEqual({ ok: true, value: false });
    expect(phpUnserialize('N;')).toEqual({ ok: true, value: null });
    expect(phpUnserialize('s:0:"";')).toEqual({ ok: true, value: '' });
    expect(phpUnserialize('s:3:"a"b";')).toEqual({ ok: true, value: 'a"b' });
    expect(phpUnserialize('i:9007199254740993;')).toEqual({ ok: true, value: '9007199254740993' });
  });

  it('reads nested arrays, string keys and keys out of order as objects', () => {
    expect(phpUnserialize('a:2:{s:1:"a";i:1;s:1:"b";a:0:{}}')).toEqual({ ok: true, value: { a: 1, b: [] } });
    expect(phpUnserialize('a:2:{i:1;s:1:"x";i:5;s:1:"y";}')).toEqual({ ok: true, value: { 1: 'x', 5: 'y' } });
    expect(phpUnserialize('a:1:{i:0;a:2:{i:0;s:9:"label-new";i:1;s:0:"";}}')).toEqual({ ok: true, value: [['label-new', '']] });
  });

  it('keeps a key named __proto__ as a plain key', () => {
    const result = phpUnserialize('a:1:{s:9:"__proto__";a:1:{s:5:"admin";b:1;}}');
    expect(result.ok).toBe(true);
    const value = (result as { value: Record<string, unknown> }).value;
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('treats a string whose byte count is wrong as broken', () => {
    expect(phpUnserialize('a:1:{i:0;s:4:"Café";}')).toEqual({ ok: false, strings: ['Café'] });
    expect(phpUnserialize('a:1:{i:0;s:9:"Café";}')).toEqual({ ok: false, strings: ['Café'] });
  });

  it('refuses trailing bytes, unknown types and objects', () => {
    expect(phpUnserialize('i:1;x')).toEqual({ ok: false, strings: [] });
    expect(phpUnserialize('O:8:"stdClass":0:{}')).toEqual({ ok: false, strings: [] });
    expect(phpUnserialize('')).toEqual({ ok: false, strings: [] });
    expect(phpUnserialize('plain text')).toEqual({ ok: false, strings: [] });
  });

  it('stays bounded on hostile input', () => {
    expect(phpUnserialize(`${'a:1:{i:0;'.repeat(5000)}N;${'}'.repeat(5000)}`).ok).toBe(false);
    expect(phpUnserialize('a:999999999:{i:0;N;}')).toEqual({ ok: false, strings: [] });
    expect(phpUnserialize('s:99999999999999999999:"x";')).toEqual({ ok: false, strings: ['x'] });
  });
});
