import { describe, expect, it } from 'vitest';
import { XmlError, createXmlReader } from '../../src/xml/index.js';
import type { XmlEvent } from '../../src/xml/index.js';

// Spec §5.1 and the Global Constraints: our own streaming XML tokenizer. It refuses any DOCTYPE, accepts only the five
// predefined entities and numeric character references, and bounds what it holds (S9).

type ReaderOptions = Parameters<typeof createXmlReader>[0];

/** Feeds `doc` in chunks of `size` code units and collects every event, including those of end(). */
function readAll(doc: string, size = doc.length || 1, o?: ReaderOptions): XmlEvent[] {
  const reader = createXmlReader(o);
  const events: XmlEvent[] = [];
  for (let i = 0; i < doc.length; i += size) events.push(...reader.write(doc.slice(i, i + size)));
  events.push(...reader.end());
  return events;
}

/** The XmlError that reading `doc` throws (failing the test when it throws nothing or something else). */
function xmlErrorOf(doc: string, size?: number, o?: ReaderOptions): XmlError {
  try {
    readAll(doc, size, o);
  } catch (e) {
    if (e instanceof XmlError) return e;
    throw e;
  }
  throw new Error('expected an XmlError');
}

const open = (name: string, attrs: Record<string, string> = {}, selfClosing = false): XmlEvent => ({ type: 'open', name, attrs, selfClosing });
const close = (name: string): XmlEvent => ({ type: 'close', name });
const text = (t: string): XmlEvent => ({ type: 'text', text: t });

const MARCXML = [
  '\u{FEFF}<?xml version="1.0" encoding="UTF-8"?>\r\n',
  '<!-- harvested -- from a test server -->\r\n',
  '<marc:collection xmlns:marc="http://www.loc.gov/MARC21/slim" note=\'a > b &amp; "c"\'>\r\n',
  '  <marc:record>\n',
  '    <marc:leader>00000nam a2200000 a 4500</marc:leader>\n',
  '    <marc:controlfield tag="001">rec-1</marc:controlfield>\n',
  '    <marc:datafield tag="245" ind1="1" ind2="4">\n',
  '      <marc:subfield code="a">The Café &lt;Bumi&gt; &#x1F600; &#233;tude</marc:subfield>\n',
  '      <marc:subfield code="b"><![CDATA[x < y & ]] z]]></marc:subfield>\n',
  '      <?php echo 1; ?><marc:subfield code="c">Pramoedya<!-- x -->Ananta</marc:subfield>\n',
  '    </marc:datafield>\n',
  '    <marc:datafield tag="020" ind1=" " ind2=" "><marc:subfield code="a">978-602-03-3295-6</marc:subfield></marc:datafield>\n',
  '  </marc:record>\r\n',
  '  <marc:record><marc:leader/></marc:record>\r',
  '</marc:collection>\r\n',
].join('');

describe('createXmlReader: events', () => {
  it('reports open, close and text events; CDATA is text; comments, PIs and the declaration are skipped', () => {
    expect(readAll('<?xml version="1.0"?><!-- c --><a x="1" y=\'2\'><b>t&amp;u</b><c/><![CDATA[<raw>]]></a>')).toEqual([
      open('a', { x: '1', y: '2' }),
      open('b'),
      text('t&u'),
      close('b'),
      open('c', {}, true),
      close('c'),
      text('<raw>'),
      close('a'),
    ]);
  });

  it('joins text around a comment, a PI and a CDATA section into one text event', () => {
    expect(readAll('<a>x<!-- c -->y<?pi z?><![CDATA[&]]>w</a>')).toEqual([open('a'), text('xy&w'), close('a')]);
  });

  it('decodes the five predefined entities and numeric references, in text and attributes', () => {
    expect(readAll('<a v="&lt;&gt;&amp;&apos;&quot;&#65;&#x42;">&lt;&gt;&amp;&apos;&quot;&#x1F600;&#128512;</a>')).toEqual([
      open('a', { v: `<>&'"AB` }),
      text(`<>&'"😀😀`),
      close('a'),
    ]);
  });

  it('normalizes CRLF and CR to LF, and attribute whitespace to spaces (a character reference survives)', () => {
    expect(readAll('<a v="x\ty\r\nz&#10;&#9;">1\r\n2\r3</a>')).toEqual([open('a', { v: 'x y z\n\t' }), text('1\n2\n3'), close('a')]);
  });

  it('skips a leading BOM and whitespace outside the root element', () => {
    expect(readAll('\u{FEFF} \n<a/>\n ')).toEqual([open('a', {}, true), close('a')]);
  });

  it('accepts `>` inside an attribute value and whitespace around `=`', () => {
    expect(readAll('<a b = "x>y" c=\'"\' ></a>')).toEqual([open('a', { b: 'x>y', c: '"' }), close('a')]);
  });

  it('accepts XML 1.0 names beyond ASCII: combining marks, the middle dot, astral letters', () => {
    expect(readAll('<e\u{301}·x a\u{301}-b.c="1"><\u{20000}/></e\u{301}·x>')).toEqual([
      open('e\u{301}·x', { 'a\u{301}-b.c': '1' }),
      open('\u{20000}', {}, true),
      close('\u{20000}'),
      close('e\u{301}·x'),
    ]);
    expect(xmlErrorOf('<\u{301}a/>').reason).toBe('syntax');
    expect(xmlErrorOf('<a×b/>').reason).toBe('syntax');
  });

  it('keeps attribute names such as __proto__ and constructor as own properties', () => {
    const [first] = readAll('<a __proto__="x" constructor="y"/>');
    if (first?.type !== 'open') throw new Error('expected an open event');
    expect(Object.keys(first.attrs)).toEqual(['__proto__', 'constructor']);
    expect(first.attrs['__proto__']).toBe('x');
    expect(first.attrs['constructor']).toBe('y');
    expect(first.attrs['toString']).toBeUndefined();
  });

  it('yields the same events whatever the chunk size', () => {
    const whole = readAll(MARCXML);
    expect(whole.length).toBeGreaterThan(20);
    expect(whole).toContainEqual(text('The Café <Bumi> 😀 étude'));
    expect(whole).toContainEqual(text('x < y & ]] z'));
    expect(whole).toContainEqual(text('PramoedyaAnanta'));
    expect(whole).toContainEqual(open('marc:collection', { 'xmlns:marc': 'http://www.loc.gov/MARC21/slim', note: 'a > b & "c"' }));
    expect(whole.at(-1)).toEqual(close('marc:collection'));
    for (const size of [1, 2, 3, 7, 64]) expect(readAll(MARCXML, size)).toEqual(whole);
  });

  it('emits each event as soon as its markup is complete', () => {
    const reader = createXmlReader();
    expect(reader.write('<a><b>te')).toEqual([open('a'), open('b')]);
    expect(reader.write('xt</b')).toEqual([]);
    expect(reader.write('>')).toEqual([text('text'), close('b')]);
    expect(reader.write('</a>')).toEqual([close('a')]);
    expect(reader.end()).toEqual([]);
  });
});

describe('createXmlReader: refusals', () => {
  it('refuses a DOCTYPE and any other markup declaration', () => {
    expect(xmlErrorOf('<!DOCTYPE x [<!ENTITY e "a">]><x/>').reason).toBe('doctype');
    expect(xmlErrorOf('<!DOCTYPE x [<!ENTITY e "a">]><x/>', 1).reason).toBe('doctype');
    expect(xmlErrorOf('<!doctype x><x/>').reason).toBe('doctype');
    expect(xmlErrorOf('<!ENTITY e "a"><x/>').reason).toBe('doctype');
    expect(xmlErrorOf('<x><!ELEMENT y ANY></x>').reason).toBe('doctype');
  });

  it('refuses an unknown entity, a bare ampersand and a reference to a character XML forbids', () => {
    expect(xmlErrorOf('<x>&foo;</x>').reason).toBe('entity');
    expect(xmlErrorOf('<x>&foo;</x>', 1).reason).toBe('entity');
    expect(xmlErrorOf('<x a="&foo;"/>').reason).toBe('entity');
    expect(xmlErrorOf('<x>a & b</x>').reason).toBe('entity');
    expect(xmlErrorOf('<x a="a & b"/>').reason).toBe('entity');
    expect(xmlErrorOf('<x>&#0;</x>').reason).toBe('entity');
    expect(xmlErrorOf('<x>&#xD800;</x>').reason).toBe('entity');
    expect(xmlErrorOf('<x>&#x110000;</x>').reason).toBe('entity');
    expect(xmlErrorOf('<x>&#xFFFE;</x>').reason).toBe('entity');
    expect(xmlErrorOf('<x>&#;</x>').reason).toBe('entity');
    expect(xmlErrorOf('<x>&#x;</x>').reason).toBe('entity');
    expect(xmlErrorOf(`<x>&#${'0'.repeat(40)}65;</x>`).reason).toBe('entity');
  });

  it('refuses bad nesting', () => {
    expect(xmlErrorOf('<a><b></a></b>').reason).toBe('nesting');
    expect(xmlErrorOf('</a>').reason).toBe('nesting');
    expect(xmlErrorOf('<a></a></a>').reason).toBe('nesting');
  });

  it('refuses what is not well-formed', () => {
    expect(xmlErrorOf('<a b=1/>').reason).toBe('syntax');
    expect(xmlErrorOf('<a b="1"c="2"/>').reason).toBe('syntax');
    expect(xmlErrorOf('<a b="1" b="2"/>').reason).toBe('syntax');
    expect(xmlErrorOf('<a b="<"/>').reason).toBe('syntax');
    expect(xmlErrorOf('<1a/>').reason).toBe('syntax');
    expect(xmlErrorOf('< a/>').reason).toBe('syntax');
    expect(xmlErrorOf('<a / >').reason).toBe('syntax');
    expect(xmlErrorOf('<a></a x>').reason).toBe('syntax');
    expect(xmlErrorOf('text<a/>').reason).toBe('syntax');
    expect(xmlErrorOf('<a/>text').reason).toBe('syntax');
    expect(xmlErrorOf('<a/><b/>').reason).toBe('syntax');
    expect(xmlErrorOf('<![CDATA[x]]><a/>').reason).toBe('syntax');
  });

  it('refuses a document that ends early', () => {
    expect(xmlErrorOf('<a><b></b>').reason).toBe('truncated');
    expect(xmlErrorOf('<a x="1').reason).toBe('truncated');
    expect(xmlErrorOf('<a><!-- x').reason).toBe('truncated');
    expect(xmlErrorOf('<a>&amp').reason).toBe('truncated');
    expect(xmlErrorOf('').reason).toBe('truncated');
    expect(xmlErrorOf('<?xml version="1.0"?>').reason).toBe('truncated');
  });

  it('keeps failing after an error, and refuses input after end()', () => {
    const reader = createXmlReader();
    expect(() => reader.write('<!DOCTYPE x>')).toThrow(XmlError);
    expect(() => reader.write('<x/>')).toThrow(XmlError);
    expect(() => reader.end()).toThrow(XmlError);
    const done = createXmlReader();
    done.write('<x/>');
    done.end();
    expect(() => done.write('<y/>')).toThrow();
  });

  it('is an Error named XmlError that carries its reason', () => {
    const e = xmlErrorOf('<x>&foo;</x>');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('XmlError');
    expect(e.reason).toBe('entity');
    expect(new XmlError('doctype').reason).toBe('doctype');
  });
});

describe('createXmlReader: limits', () => {
  it('bounds the depth (default 64)', () => {
    const nested = (n: number) => `${'<a>'.repeat(n)}${'</a>'.repeat(n)}`;
    expect(readAll(nested(64))).toHaveLength(128);
    expect(xmlErrorOf(nested(65)).reason).toBe('limit');
    expect(readAll(nested(3), undefined, { maxDepth: 3 })).toHaveLength(6);
    expect(xmlErrorOf('<a><b><c><d/></c></b></a>', undefined, { maxDepth: 3 }).reason).toBe('limit');
  });

  it('bounds one text event in UTF-8 bytes', () => {
    expect(readAll(`<a>${'x'.repeat(10)}</a>`, undefined, { maxTextBytes: 10 })).toContainEqual(text('x'.repeat(10)));
    expect(xmlErrorOf(`<a>${'x'.repeat(11)}</a>`, undefined, { maxTextBytes: 10 }).reason).toBe('limit');
    expect(xmlErrorOf(`<a>${'é'.repeat(6)}</a>`, undefined, { maxTextBytes: 10 }).reason).toBe('limit');
    expect(xmlErrorOf(`<a>xxxxxx<![CDATA[xxxxx]]></a>`, undefined, { maxTextBytes: 10 }).reason).toBe('limit');
    expect(xmlErrorOf(`<a>${'&amp;'.repeat(11)}</a>`, undefined, { maxTextBytes: 10 }).reason).toBe('limit');
  });

  it('bounds a pending tag, comment, CDATA section and PI in bytes', () => {
    const o = { maxTagBytes: 20 };
    expect(readAll(`<a b="${'x'.repeat(10)}"/>`, 1, o)).toHaveLength(2);
    expect(xmlErrorOf(`<a b="${'x'.repeat(20)}"/>`, 1, o).reason).toBe('limit');
    expect(xmlErrorOf(`<a${' '.repeat(30)}/>`, 1, o).reason).toBe('limit');
    expect(xmlErrorOf(`<a></a${' '.repeat(30)}>`, 1, o).reason).toBe('limit');
    expect(xmlErrorOf(`<a><!--${'x'.repeat(30)}--></a>`, 1, o).reason).toBe('limit');
    expect(xmlErrorOf(`<a><![CDATA[${'x'.repeat(30)}]]></a>`, 1, o).reason).toBe('limit');
    expect(xmlErrorOf(`<a><?pi ${'x'.repeat(30)}?></a>`, 1, o).reason).toBe('limit');
  });

  it('refuses invalid options', () => {
    expect(() => createXmlReader({ maxDepth: 0 })).toThrow(RangeError);
    expect(() => createXmlReader({ maxTextBytes: 1.5 })).toThrow(RangeError);
    expect(() => createXmlReader({ maxTagBytes: -1 })).toThrow(RangeError);
  });

  // S9: an unterminated construct cannot hold a whole upload in memory.
  const MIB = 1024 * 1024;
  const CHUNK = 64 * 1024;

  /**
   * Writes `head` and then 2 MiB (code units) of `fill` in 64 KiB chunks. Returns the error and how many code units of
   * fill had gone in when it was thrown.
   */
  function feedUnterminated(head: string, fill: string): { error: unknown; fed: number } {
    const reader = createXmlReader();
    const chunk = fill.repeat(CHUNK / fill.length);
    let fed = 0;
    try {
      reader.write(head);
      while (fed < 2 * MIB) {
        fed += chunk.length;
        reader.write(chunk);
      }
      reader.end();
    } catch (error) {
      return { error, fed };
    }
    return { error: null, fed };
  }

  it('S9: an attribute value without its closing quote fails at about 1 MiB', () => {
    const { error, fed } = feedUnterminated('<a b="', 'x');
    expect(error).toBeInstanceOf(XmlError);
    expect((error as XmlError).reason).toBe('limit');
    expect(fed).toBeLessThanOrEqual(MIB);
  });

  it('S9: an unterminated comment fails at about 1 MiB', () => {
    const { error, fed } = feedUnterminated('<a><!--', 'x');
    expect(error).toBeInstanceOf(XmlError);
    expect((error as XmlError).reason).toBe('limit');
    expect(fed).toBeLessThanOrEqual(MIB + CHUNK);
  });

  it('S9: an unterminated CDATA section and a text node fail at about 1 MiB', () => {
    // 'é' is 2 bytes in UTF-8: the limit counts bytes, so it trips after about 512 Ki characters.
    const cdata = feedUnterminated('<a><![CDATA[', 'é');
    expect(cdata.error).toBeInstanceOf(XmlError);
    expect((cdata.error as XmlError).reason).toBe('limit');
    expect(cdata.fed).toBeLessThanOrEqual(MIB / 2 + CHUNK);
    const textNode = feedUnterminated('<a>', 'x');
    expect(textNode.error).toBeInstanceOf(XmlError);
    expect((textNode.error as XmlError).reason).toBe('limit');
    expect(textNode.fed).toBeLessThanOrEqual(MIB + CHUNK);
  });
});
