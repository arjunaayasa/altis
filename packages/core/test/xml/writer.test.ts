import { describe, expect, it } from 'vitest';
import { XmlWriter, createXmlReader, stripInvalidXmlChars, xmlAttr, xmlEscape } from '../../src/xml/index.js';
import type { XmlEvent } from '../../src/xml/index.js';

// Spec §10 and the Global Constraints: our own XML writer. It escapes text and drops the characters XML 1.0 forbids.

describe('xmlEscape, xmlAttr and stripInvalidXmlChars', () => {
  it('escapes < & > and quotes, and drops forbidden characters', () => {
    expect(xmlEscape(`a<b&c>d"e'f`)).toBe(`a&lt;b&amp;c&gt;d&quot;e'f`);
    expect(xmlEscape('x\u0001y\u0000z')).toBe('xyz');
    expect(xmlEscape(']]>')).toBe(']]&gt;');
  });

  it('keeps a carriage return as a reference in text, which a reader would otherwise turn into a line feed', () => {
    expect(xmlEscape('a\r\nb\tc')).toBe('a&#13;\nb\tc');
  });

  it('escapes tab, line feed and carriage return in an attribute value', () => {
    expect(xmlAttr('a"b<c&d\te\nf\rg')).toBe('a&quot;b&lt;c&amp;d&#9;e&#10;f&#13;g');
  });

  it('removes C0 controls except tab, LF and CR, lone surrogates, U+FFFE and U+FFFF', () => {
    expect(stripInvalidXmlChars('a\u0001b\u001fc\u{FFFE}d\u{FFFF}e\uD800f\uDC00g😀\t\n\r')).toBe('abcdefg😀\t\n\r');
    expect(stripInvalidXmlChars('\u0085\u007f\u{E000}\u{FFFD}')).toBe('\u0085\u007f\u{E000}\u{FFFD}');
  });
});

describe('XmlWriter', () => {
  it('escapes <&" in text and attributes and drops \\u0001', () => {
    const w = new XmlWriter().open('a', { x: 'a<&"b\u0001' }).text('1 < 2 & "q"\u0001').close();
    expect(w.toString()).toBe('<a x="a&lt;&amp;&quot;b">1 &lt; 2 &amp; &quot;q&quot;</a>');
  });

  it('writes leaves, skips null attributes and writes numbers', () => {
    const w = new XmlWriter();
    w.open('r', { n: 3, skip: null, gone: undefined });
    w.leaf('t', 'Laskar Pelangi', { lang: 'id' });
    w.leaf('e', '');
    w.leaf('y', 2005);
    w.close();
    expect(w.toString()).toBe('<r n="3"><t lang="id">Laskar Pelangi</t><e/><y>2005</y></r>');
  });

  it('appends trusted XML as is', () => {
    const w = new XmlWriter().raw('<?xml version="1.0" encoding="UTF-8"?>\n').open('a').raw('<b c="1"/>').close();
    expect(w.toString()).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<a><b c="1"/></a>');
  });

  it('closes elements in order and refuses a close without an open element', () => {
    const w = new XmlWriter().open('a').open('b').close().close();
    expect(w.toString()).toBe('<a><b></b></a>');
    expect(() => w.close()).toThrow();
  });

  it('refuses to render while an element is still open', () => {
    const w = new XmlWriter().open('a');
    expect(() => w.toString()).toThrow();
  });

  it('refuses an invalid element or attribute name', () => {
    expect(() => new XmlWriter().open('1a')).toThrow();
    expect(() => new XmlWriter().open('a b')).toThrow();
    expect(() => new XmlWriter().open('a', { 'x"y': '1' })).toThrow();
    expect(() => new XmlWriter().leaf('a>', 'x')).toThrow();
    expect(() => new XmlWriter().open('marc:record', { 'xmlns:marc': 'http://www.loc.gov/MARC21/slim' })).not.toThrow();
  });

  it('round-trips through the reader, whitespace and carriage returns included', () => {
    const value = 'tab\there\nline\r\nend & <x> "q" \u0002';
    const w = new XmlWriter().open('a', { v: value }).leaf('b', value).close();
    const reader = createXmlReader();
    const events: XmlEvent[] = [...reader.write(w.toString()), ...reader.end()];
    const clean = stripInvalidXmlChars(value);
    expect(events).toEqual([
      { type: 'open', name: 'a', attrs: { v: clean }, selfClosing: false },
      { type: 'open', name: 'b', attrs: {}, selfClosing: false },
      { type: 'text', text: clean },
      { type: 'close', name: 'b' },
      { type: 'close', name: 'a' },
    ]);
  });
});
