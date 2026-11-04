import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/jcs.js';
import { looseStringify, prng, randomJson } from './support.js';

// ---------------------------------------------------------------------------
// RFC 8785 test vectors, copied verbatim from https://www.rfc-editor.org/rfc/rfc8785.txt
// ---------------------------------------------------------------------------

// The vectors are written as arrays of the RFC's display lines (ordinary string literals, backslashes
// doubled): the test transform rewrites \uXXXX escapes inside String.raw templates.

/** RFC 8785 §3.2.2: the sample JSON text (the sample that §3.2.3 canonicalizes). */
const RFC_SAMPLE_JSON = [
  '     {',
  '       "numbers": [333333333.33333329, 1E30, 4.50,',
  '                   2e-3, 0.000000000000000000000000001],',
  '       "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",',
  '       "literals": [null, true, false]',
  '     }',
].join('\n');

/**
 * RFC 8785 §3.2.3: the canonicalized sample. The RFC prints it "with a line wrap added for display
 * purposes only"; the two display lines are joined without their indentation.
 */
const RFC_SAMPLE_CANONICAL = [
  '     {"literals":[null,true,false],"numbers":[333333333.3333333,',
  '     1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
]
  .map((line) => line.trim())
  .join('');

/** RFC 8785 §3.2.4: the UTF-8 bytes of the canonicalized sample. */
const RFC_SAMPLE_UTF8_HEX = `
     7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
     75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
     5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
     65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
     5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
     30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d
`;

/** RFC 8785 §3.2.3: sorting test data. */
const RFC_SORT_JSON = [
  '     {',
  '       "\\u20ac": "Euro Sign",',
  '       "\\r": "Carriage Return",',
  '       "\\ufb33": "Hebrew Letter Dalet With Dagesh",',
  '       "1": "One",',
  '       "\\ud83d\\ude00": "Emoji: Grinning Face",',
  '       "\\u0080": "Control",',
  '       "\\u00f6": "Latin Small Letter O With Diaeresis"',
  '     }',
].join('\n');

/** RFC 8785 §3.2.3: "Expected argument order after sorting property strings". */
const RFC_SORT_EXPECTED = [
  'Carriage Return',
  'One',
  'Control',
  'Latin Small Letter O With Diaeresis',
  'Euro Sign',
  'Emoji: Grinning Face',
  'Hebrew Letter Dalet With Dagesh',
];

/** RFC 8785 Appendix B, Table 1: IEEE 754 bit pattern -> JSON representation (null: NaN/Infinity, an error). */
const RFC_NUMBER_SAMPLES: [hex: string, json: string | null, comment: string][] = [
  ['0000000000000000', '0', 'Zero'],
  ['8000000000000000', '0', 'Minus zero'],
  ['0000000000000001', '5e-324', 'Min pos number'],
  ['8000000000000001', '-5e-324', 'Min neg number'],
  ['7fefffffffffffff', '1.7976931348623157e+308', 'Max pos number'],
  ['ffefffffffffffff', '-1.7976931348623157e+308', 'Max neg number'],
  ['4340000000000000', '9007199254740992', 'Max pos int (1)'],
  ['c340000000000000', '-9007199254740992', 'Max neg int (1)'],
  ['4430000000000000', '295147905179352830000', '~2**68 (2)'],
  ['7fffffffffffffff', null, 'NaN (3)'],
  ['7ff0000000000000', null, 'Infinity (3)'],
  ['44b52d02c7e14af5', '9.999999999999997e+22', ''],
  ['44b52d02c7e14af6', '1e+23', ''],
  ['44b52d02c7e14af7', '1.0000000000000001e+23', ''],
  ['444b1ae4d6e2ef4e', '999999999999999700000', ''],
  ['444b1ae4d6e2ef4f', '999999999999999900000', ''],
  ['444b1ae4d6e2ef50', '1e+21', ''],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7', ''],
  ['3eb0c6f7a0b5ed8d', '0.000001', ''],
  ['41b3de4355555553', '333333333.3333332', ''],
  ['41b3de4355555554', '333333333.33333325', ''],
  ['41b3de4355555555', '333333333.3333333', ''],
  ['41b3de4355555556', '333333333.3333334', ''],
  ['41b3de4355555557', '333333333.33333343', ''],
  ['becbf647612f3696', '-0.0000033333333333333333', ''],
  ['43143ff3c1cb0959', '1424953923781206.2', 'Round to even (4)'],
];

const ieee754 = (hex: string): number => Buffer.from(hex, 'hex').readDoubleBE(0);

describe('canonicalize: RFC 8785 vectors', () => {
  it('§3.2.3: canonicalizes the §3.2.2 sample exactly', () => {
    expect(canonicalize(JSON.parse(RFC_SAMPLE_JSON))).toBe(RFC_SAMPLE_CANONICAL);
  });

  it('§3.2.4: the canonical sample has the expected UTF-8 bytes', () => {
    const bytes = Buffer.from(canonicalize(JSON.parse(RFC_SAMPLE_JSON)), 'utf8');
    expect(bytes.toString('hex')).toBe(RFC_SAMPLE_UTF8_HEX.replace(/\s+/g, ''));
  });

  it('§3.2.3: sorts the sorting test data in the expected order', () => {
    const out = canonicalize(JSON.parse(RFC_SORT_JSON));
    const values = [...out.matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual(RFC_SORT_EXPECTED);
  });

  it.each(RFC_NUMBER_SAMPLES)('Appendix B: %s -> %s (%s)', (hex, json) => {
    const n = ieee754(hex);
    if (json === null) {
      expect(() => canonicalize(n)).toThrow(/^JCS_INVALID:non_finite/);
      expect(() => canonicalize([n])).toThrow(/^JCS_INVALID:non_finite/);
    } else {
      expect(canonicalize(n)).toBe(json);
      expect(canonicalize({ n })).toBe(`{"n":${json}}`);
    }
  });
});

describe('canonicalize: objects', () => {
  it('sorts properties', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts by UTF-16 code units, not by locale', () => {
    expect(canonicalize({ z: 1, é: 2 })).toBe('{"z":1,"é":2}');
    expect(canonicalize({ é: 2, z: 1 })).toBe('{"z":1,"é":2}');
    expect(canonicalize({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
    expect(canonicalize({ aa: 1, '': 2, ab: 3, a: 4 })).toBe('{"":2,"a":4,"aa":1,"ab":3}');
    // U+1F600 (code units D83D DE00) sorts before U+FB33 in UTF-16, after it in code point order.
    expect(canonicalize({ 'דּ': 1, '😀': 2 })).toBe('{"😀":2,"דּ":1}');
  });

  it('sorts integer-like keys as strings', () => {
    expect(canonicalize({ 10: 'a', 9: 'b', 1: 'c', x: 'd' })).toBe('{"1":"c","10":"a","9":"b","x":"d"}');
  });

  it('sorts nested objects, including objects inside arrays, and keeps array order', () => {
    expect(canonicalize({ z: [{ d: 1, c: 2 }, 3, [{ f: 1, e: 2 }]], y: { b: { y: 1, x: 2 }, a: null } })).toBe(
      '{"y":{"a":null,"b":{"x":2,"y":1}},"z":[{"c":2,"d":1},3,[{"e":2,"f":1}]]}',
    );
  });

  it('emits no whitespace', () => {
    expect(canonicalize({ a: [1, { b: 'x y' }], c: {} })).toBe('{"a":[1,{"b":"x y"}],"c":{}}');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({})).toBe('{}');
  });

  it('omits properties whose value is undefined, as JSON.stringify does', () => {
    expect(canonicalize({ a: undefined, b: 1, c: undefined })).toBe('{"b":1}');
    expect(canonicalize({ a: undefined })).toBe('{}');
  });

  it('accepts objects without a prototype', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o['b'] = 1;
    o['a'] = 2;
    expect(canonicalize(o)).toBe('{"a":2,"b":1}');
  });

  it('serializes an own "__proto__" property (as JSON.parse creates it)', () => {
    expect(canonicalize(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it('serializes a shared (non-cyclic) reference each time it appears', () => {
    const shared = { a: 1 };
    expect(canonicalize([shared, { s: shared }])).toBe('[{"a":1},{"s":{"a":1}}]');
  });

  it('ignores symbol-keyed and non-enumerable properties', () => {
    const o: Record<string | symbol, unknown> = { a: 1, [Symbol('s')]: 2 };
    Object.defineProperty(o, 'hidden', { value: 3, enumerable: false });
    expect(canonicalize(o)).toBe('{"a":1}');
  });
});

describe('canonicalize: primitives', () => {
  it('serializes literals', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize([null, true, false])).toBe('[null,true,false]');
  });

  it('serializes -0 as 0', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize({ a: -0, b: [-0] })).toBe('{"a":0,"b":[0]}');
  });

  it('serializes numbers like Number.prototype.toString', () => {
    for (const n of [1, -1, 0.1, 1.5, 100, 1e20, 1e21, 1e-6, 1e-7, 123e-20, 2 ** 53 + 2, 4.5, 0.002, 1e30]) {
      expect(canonicalize(n)).toBe(String(n));
    }
  });

  it('throws on NaN and infinities', () => {
    expect(() => canonicalize(NaN)).toThrow(/^JCS_INVALID:non_finite/);
    expect(() => canonicalize(Infinity)).toThrow(/^JCS_INVALID:non_finite/);
    expect(() => canonicalize(-Infinity)).toThrow(/^JCS_INVALID:non_finite/);
    expect(() => canonicalize({ a: { b: [1, NaN] } })).toThrow('JCS_INVALID:non_finite at /a/b/1');
  });

  it('escapes strings as ECMAScript JSON.stringify does', () => {
    expect(canonicalize('\u0000\u0001\u001f')).toBe('"\\u0000\\u0001\\u001f"');
    expect(canonicalize('\b\t\n\f\r')).toBe('"\\b\\t\\n\\f\\r"');
    expect(canonicalize('\u000b\u000e')).toBe('"\\u000b\\u000e"');
    expect(canonicalize('"\\')).toBe('"\\"\\\\"');
    expect(canonicalize('/')).toBe('"/"');
    expect(canonicalize('\u007f\u0080é€  ﻿😀')).toBe('"\u007f\u0080é€  ﻿😀"');
  });

  it('escapes property names like strings', () => {
    expect(canonicalize({ 'a"b': 1, '\n': 2 })).toBe('{"\\n":2,"a\\"b":1}');
  });

  it('throws on lone surrogates in strings and in property names', () => {
    for (const bad of ['\ud800', '\udfff', 'a\ud83d', '\ude00a', '\ude00\ud83d', '\ud83d😀x\udbff']) {
      expect(() => canonicalize(bad)).toThrow(/^JCS_INVALID:lone_surrogate/);
      expect(() => canonicalize({ [bad]: 1 })).toThrow(/^JCS_INVALID:lone_surrogate/);
      expect(() => canonicalize([{ k: bad }])).toThrow('JCS_INVALID:lone_surrogate at /0/k');
    }
    expect(canonicalize('😀􏿿')).toBe('"😀􏿿"');
  });
});

describe('canonicalize: values outside the JSON data model', () => {
  class Point {
    x = 1;
    y = 2;
  }

  it.each([
    ['undefined', undefined, /^JCS_INVALID:undefined/],
    ['undefined in an array', [1, undefined], /^JCS_INVALID:undefined at \/1/],
    // eslint-disable-next-line no-sparse-arrays
    ['an array hole', [1, , 3], /^JCS_INVALID:undefined at \/1/],
    ['a function', () => 1, /^JCS_INVALID:function/],
    ['a function property', { f: () => 1 }, /^JCS_INVALID:function at \/f/],
    ['a symbol', Symbol('s'), /^JCS_INVALID:symbol/],
    ['a bigint', 10n, /^JCS_INVALID:bigint/],
    ['a Date', new Date(0), /^JCS_INVALID:object/],
    ['a Map', new Map(), /^JCS_INVALID:object/],
    ['a Uint8Array', new Uint8Array(2), /^JCS_INVALID:object/],
    ['a class instance', new Point(), /^JCS_INVALID:object/],
    ['a boxed number', Object(1), /^JCS_INVALID:object/],
  ])('throws on %s', (_name, value, error) => {
    expect(() => canonicalize(value)).toThrow(error);
  });

  it('throws TypeError', () => {
    expect(() => canonicalize(NaN)).toThrow(TypeError);
    expect(() => canonicalize(new Date(0))).toThrow(TypeError);
  });

  it('throws on cycles', () => {
    const a: Record<string, unknown> = { x: 1 };
    a['self'] = a;
    expect(() => canonicalize(a)).toThrow('JCS_INVALID:cycle at /self');
    const arr: unknown[] = [1];
    arr.push({ back: arr });
    expect(() => canonicalize(arr)).toThrow('JCS_INVALID:cycle at /1/back');
  });

  it('escapes "/" and "~" in error paths (JSON Pointer)', () => {
    expect(() => canonicalize({ 'a/b': { 'c~d': NaN } })).toThrow('JCS_INVALID:non_finite at /a~1b/c~0d');
  });
});

describe('canonicalize: properties', () => {
  it('is idempotent through JSON.parse', () => {
    const rand = prng(8785);
    for (let i = 0; i < 500; i++) {
      const out = canonicalize(randomJson(rand));
      expect(canonicalize(JSON.parse(out))).toBe(out);
    }
  });

  it('does not depend on whitespace, escapes, number spelling or property order of the JSON text', () => {
    const rand = prng(42);
    for (let i = 0; i < 500; i++) {
      const v = randomJson(rand);
      const expected = canonicalize(v);
      expect(canonicalize(JSON.parse(looseStringify(rand, v)))).toBe(expected);
      expect(canonicalize(JSON.parse(JSON.stringify(v, null, 2)))).toBe(expected);
    }
  });

  it('produces valid JSON that parses back to an equal value', () => {
    const rand = prng(7);
    for (let i = 0; i < 300; i++) {
      const v = randomJson(rand);
      expect(JSON.parse(canonicalize(v))).toEqual(JSON.parse(JSON.stringify(v)));
    }
  });
});
