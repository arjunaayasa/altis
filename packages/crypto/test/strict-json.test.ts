import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH, parseStrictJson } from '../src/strict-json.js';
import { jsonDiff, looseStringify, prng, randomJson } from './support.js';

/** Asserts that both parsers accept `text` and agree (same shape, key order, prototypes, -0 kept). */
function expectSameAsJsonParse(text: string): unknown {
  const expected: unknown = JSON.parse(text);
  const got = parseStrictJson(text);
  expect(jsonDiff(got, expected), text).toBeNull();
  return got;
}

describe('parseStrictJson: duplicate keys', () => {
  it('rejects a duplicate key', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(new Error('DUPLICATE_KEY:a'));
  });

  it('compares keys after unescaping', () => {
    expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow('DUPLICATE_KEY:a');
    expect(() => parseStrictJson('{"\\/":1,"/":2}')).toThrow('DUPLICATE_KEY:/');
  });

  it('rejects duplicates in nested objects and inside arrays', () => {
    expect(() => parseStrictJson('{"x":{"b":1,"c":0,"b":2}}')).toThrow('DUPLICATE_KEY:b');
    expect(() => parseStrictJson('[1,[{"k":1,"k":1}]]')).toThrow('DUPLICATE_KEY:k');
  });

  it('rejects duplicates even when the values are identical', () => {
    expect(() => parseStrictJson('{"a":1,"a":1}')).toThrow('DUPLICATE_KEY:a');
  });

  it('allows the same key in different objects', () => {
    expect(parseStrictJson('[{"a":1},{"a":2,"b":{"a":3}}]')).toEqual([{ a: 1 }, { a: 2, b: { a: 3 } }]);
  });

  it('treats "__proto__" as an ordinary own key, like JSON.parse', () => {
    const v = expectSameAsJsonParse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(['__proto__', 'a']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(() => parseStrictJson('{"__proto__":1,"__proto__":2}')).toThrow('DUPLICATE_KEY:__proto__');
  });

  it('does not mistake inherited names for duplicates', () => {
    expectSameAsJsonParse('{"toString":1,"constructor":2,"hasOwnProperty":3,"valueOf":{}}');
  });

  it('keeps the error contract: an Error whose message names the key', () => {
    let caught: unknown;
    try {
      parseStrictJson('{"key with \\"quotes\\"":1,"key with \\"quotes\\"":2}');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('DUPLICATE_KEY:key with "quotes"');
  });
});

describe('parseStrictJson: accepts what JSON.parse accepts', () => {
  it.each([
    ['literals', 'null'],
    ['true', ' true '],
    ['false', '\t\n\r false\r\n'],
    ['integers', '[0,-0,1,-1,123456789,9007199254740993]'],
    ['fractions and exponents', '[0.5,-0.25,1e3,1E3,1e+3,1e-3,-1.5E-3,0e0,0.0e-0,4.50,2e-3]'],
    ['huge and tiny numbers', '[1e400,-1e400,1e-400,5e-324,1.7976931348623157e308]'],
    ['RFC 8785 number samples', '[333333333.33333329,1E30,0.000000000000000000000000001]'],
    ['strings', '["","a","é€😀",""]'],
    ['all escapes', '"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u0000 \\u001F \\u00e9 \\u20AC"'],
    ['escaped surrogate pair', '"\\ud83d\\ude00"'],
    ['escaped lone surrogates (JSON.parse keeps them)', '["\\ud800","\\uDFFF","\\ude00\\ud83d"]'],
    ['raw lone surrogate code unit', '"\ud800"'],
    ['DEL and non-ASCII controls raw', '"\u007f\u0080\u2028\u2029"'],
    ['empty containers', '[{},[],{"a":[]},[{}]]'],
    ['nested', '{"a":{"b":{"c":[1,{"d":null}]}},"e":"f"}'],
    ['whitespace everywhere', ' {\n\t"a" :\r [ 1 , 2 ] ,"b"\n:\n{ } } '],
    ['RFC 8785 sample', '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"literals":[null,true,false]}'],
  ])('%s', (_name, text) => {
    expectSameAsJsonParse(text);
  });

  it('keeps -0', () => {
    expect(Object.is(parseStrictJson('-0'), -0)).toBe(true);
    expect(Object.is((parseStrictJson('[-0.0]') as number[])[0], -0)).toBe(true);
  });

  it('agrees with JSON.parse on random documents with random formatting', () => {
    const rand = prng(1);
    for (let i = 0; i < 1000; i++) {
      expectSameAsJsonParse(looseStringify(rand, randomJson(rand)));
    }
  });
});

describe('parseStrictJson: rejects what JSON.parse rejects', () => {
  it.each([
    ['empty text', ''],
    ['only whitespace', ' \n'],
    ['unterminated object', '{'],
    ['unterminated array', '[1,'],
    ['lone closer', '}'],
    ['trailing comma in array', '[1,]'],
    ['trailing comma in object', '{"a":1,}'],
    ['leading comma', '[,1]'],
    ['missing comma', '[1 2]'],
    ['missing colon', '{"a" 1}'],
    ['missing comma between members', '{"a":1 "b":2}'],
    ['unquoted key', '{a:1}'],
    ['single quotes', "{'a':1}"],
    ['number key', '{1:1}'],
    ['leading zero', '01'],
    ['leading zero negative', '-01'],
    ['minus alone', '-'],
    ['plus sign', '+1'],
    ['dot without digits after', '1.'],
    ['dot without digits before', '.5'],
    ['exponent without digits', '1e'],
    ['exponent sign without digits', '1e+'],
    ['hex', '0x10'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['minus Infinity', '-Infinity'],
    ['truncated literal', 'tru'],
    ['capitalized literal', 'True'],
    ['undefined', 'undefined'],
    ['unterminated string', '"abc'],
    ['raw control character in string', '"a\u0001b"'],
    ['raw newline in string', '"a\nb"'],
    ['raw tab in string', '"a\tb"'],
    ['unknown escape', '"\\x41"'],
    ['escaped single quote', '"\\\'"'],
    ['short unicode escape', '"\\u12"'],
    ['bad hex digit', '"\\u12G4"'],
    ['escape at end of text', '"\\'],
    ['comment', '/* c */ 1'],
    ['line comment', '1 // c'],
    ['BOM', '\ufeff{}'],
    ['non-breaking space as whitespace', '\u00a01'],
    ['vertical tab as whitespace', '\u000b1'],
    ['form feed as whitespace', '\f1'],
  ])('%s', (_name, text) => {
    expect(() => JSON.parse(text)).toThrow(SyntaxError);
    expect(() => parseStrictJson(text)).toThrow(SyntaxError);
    expect(() => parseStrictJson(text)).toThrow(/^JSON_SYNTAX:\d+$/);
  });

  it.each([
    ['second value', '1 2'],
    ['garbage after object', '{"a":1}garbage'],
    ['second object', '{} {}'],
    ['extra closer', '[]]'],
    ['null null', 'null null'],
    ['NUL after value', '1\u0000'],
  ])('rejects trailing garbage: %s', (_name, text) => {
    expect(() => JSON.parse(text)).toThrow(SyntaxError);
    expect(() => parseStrictJson(text)).toThrow(/^JSON_SYNTAX:\d+$/);
  });

  it('reports the offset of the problem', () => {
    expect(() => parseStrictJson('[1,]')).toThrow('JSON_SYNTAX:3');
    expect(() => parseStrictJson('{"a":1}x')).toThrow('JSON_SYNTAX:7');
  });

  it('agrees with JSON.parse on randomly damaged documents', () => {
    const rand = prng(99);
    const pool = '{}[],:"\\/0123456789-+.eEtrufalsn \t\n\rxu\u0000é';
    for (let i = 0; i < 3000; i++) {
      let text = looseStringify(rand, randomJson(rand));
      const edits = 1 + Math.floor(rand() * 3);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rand() * (text.length + 1));
        const ch = pool[Math.floor(rand() * pool.length)] ?? '';
        const op = rand();
        if (op < 0.33) text = text.slice(0, at) + text.slice(at + 1);
        else if (op < 0.66) text = text.slice(0, at) + ch + text.slice(at);
        else text = text.slice(0, at) + ch + text.slice(at + 1);
      }
      let expected: unknown;
      let jsonParseThrew = false;
      try {
        expected = JSON.parse(text);
      } catch {
        jsonParseThrew = true;
      }
      if (jsonParseThrew) {
        // A duplicate key may be found before the syntax error further on.
        expect(() => parseStrictJson(text), text).toThrow(/^(JSON_SYNTAX:\d+|DUPLICATE_KEY:.*)$/s);
        continue;
      }
      let got: unknown;
      try {
        got = parseStrictJson(text);
      } catch (err) {
        expect((err as Error).message, text).toMatch(/^DUPLICATE_KEY:/);
        continue;
      }
      expect(jsonDiff(got, expected), text).toBeNull();
    }
  });
});

describe('parseStrictJson: depth limit', () => {
  const arrays = (n: number): string => '['.repeat(n) + ']'.repeat(n);
  const objects = (n: number): string => '{"a":'.repeat(n - 1) + '{}' + '}'.repeat(n - 1);

  it('is 64', () => {
    expect(MAX_JSON_DEPTH).toBe(64);
  });

  it('accepts 64 nested containers', () => {
    expectSameAsJsonParse(arrays(64));
    expectSameAsJsonParse(objects(64));
    expectSameAsJsonParse('['.repeat(32) + objects(32) + ']'.repeat(32));
  });

  it('rejects 65 nested containers', () => {
    expect(() => parseStrictJson(arrays(65))).toThrow(new Error('JSON_TOO_DEEP'));
    expect(() => parseStrictJson(objects(65))).toThrow('JSON_TOO_DEEP');
    expect(() => parseStrictJson('['.repeat(33) + objects(32) + ']'.repeat(33))).toThrow('JSON_TOO_DEEP');
  });

  it('counts depth, not the number of containers', () => {
    expectSameAsJsonParse('[' + arrays(63) + ',' + arrays(63) + ',' + objects(63) + ']');
  });

  it('rejects very deep input without overflowing the stack', () => {
    expect(() => parseStrictJson(arrays(200_000))).toThrow('JSON_TOO_DEEP');
    expect(() => parseStrictJson('['.repeat(200_000))).toThrow('JSON_TOO_DEEP');
  });
});

describe('parseStrictJson: input', () => {
  it('rejects non-string input', () => {
    for (const bad of [undefined, null, 1, {}, Buffer.from('{}')]) {
      expect(() => parseStrictJson(bad as unknown as string)).toThrow(TypeError);
    }
  });

  it('returns fresh plain objects and arrays', () => {
    const v = parseStrictJson('{"a":[1]}') as { a: number[] };
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Array.isArray(v.a)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(v, 'a')).toEqual({ value: [1], writable: true, enumerable: true, configurable: true });
  });
});
