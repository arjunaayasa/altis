import { describe, expect, it } from 'vitest';
import { jsonForHtmlScript } from '../../src/html/json-script.js';

// JSON for an inline `<script>` element (S6; moved from Task 5 to Task 3 so that the OPAC's jsonLdScript needs no
// other Wave 0 task): the text of a `<script type="application/ld+json">` ends at the first `</script` whatever the
// JSON around it says, so `<`, `>` and `&` never appear raw, nor U+2028/U+2029 (line terminators in older JS parsers).

describe('jsonForHtmlScript', () => {
  it('a value holding </script> gives a text without </script, which parses back to the value', () => {
    const value = { a: '</script>', b: '<!-- <script>alert(1)</script> -->', c: ['</SCRIPT >', 'x&y'] };
    const text = jsonForHtmlScript(value);
    expect(text).not.toMatch(/<\/script/i);
    expect(text).not.toMatch(/[<>&]/);
    expect(JSON.parse(text)).toEqual(value);
  });

  it('escapes <, >, &, U+2028 and U+2029 as \\u escapes, nothing else', () => {
    expect(jsonForHtmlScript('<>&\u2028\u2029')).toBe('"\\u003c\\u003e\\u0026\\u2028\\u2029"');
    expect(jsonForHtmlScript({ name: 'Laskar Pelangi', year: 2005, ok: true, none: null })).toBe(
      '{"name":"Laskar Pelangi","year":2005,"ok":true,"none":null}',
    );
    expect(JSON.parse(jsonForHtmlScript({ s: 'a\u2028b\u2029c' }))).toEqual({ s: 'a\u2028b\u2029c' });
  });

  it('keeps the JSON of an object key that holds the characters too', () => {
    const value = { '</script>': 1 };
    expect(jsonForHtmlScript(value)).toBe('{"\\u003c/script\\u003e":1}');
    expect(JSON.parse(jsonForHtmlScript(value))).toEqual(value);
  });

  it.each([[undefined], [() => 1], [Symbol('x')]])('refuses %s, which has no JSON text', (value) => {
    expect(() => jsonForHtmlScript(value)).toThrow(TypeError);
  });

  it('refuses what JSON.stringify refuses (a BigInt, a cycle)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => jsonForHtmlScript(1n)).toThrow(TypeError);
    expect(() => jsonForHtmlScript(cyclic)).toThrow(TypeError);
  });
});
