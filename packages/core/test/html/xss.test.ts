// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/html/markdown.js';
import { sanitizedHtml } from '../../src/html/sanitize.js';
import { MARKDOWN_XSS_VECTORS, XSS_VECTORS } from './xss-corpus.js';

// K14 (spec §9.5, §15): the self-written XSS corpus through the sanitizer and the Markdown renderer leaves no
// executable markup. Each output is checked three ways:
// - textually, as K14 words it (no <script, no on…= attribute, no javascript:/vbscript:/data: URL, no <img> off
//   /files/<ulid>, no style=, no <svg, <iframe or <object);
// - against a strict grammar of what the sanitizer may write (allowed tags and attributes, all text escaped), which
//   does not use the sanitizer's own tokenizer;
// - through a browser's HTML parser (jsdom): the elements it builds from the output are allowed ones, and the tree it
//   builds serialises back to the same output once sanitized, so a browser reads the markup exactly as written (no
//   repair, no foster parenting, nothing for a mutation trick to work on).
// It also pins idempotence: sanitizedHtml(sanitizedHtml(x)) === sanitizedHtml(x).

const ALLOWED_TAGS = new Set([
  'p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'img', 'table', 'thead',
  'tbody', 'tr', 'th', 'td', 'hr', 'code', 'pre', 'figure', 'figcaption',
]);
const ATTRIBUTES_OF: Readonly<Record<string, readonly string[]>> = { a: ['href', 'rel', 'title'], img: ['src', 'alt', 'title'] };
const FILE_SRC = /^\/files\/[0-9A-HJKMNP-TV-Z]{26}$/;
const TAG = /<(\/?)([a-z0-9]+)((?: [a-z]+="[^"<>]*")*)>/g;
const ESCAPED_TEXT = /^(?:[^<>&]|&(?:amp|lt|gt|quot|#39);)*$/;

/** The five references the sanitizer writes, decoded (enough to read back its attribute values). */
function decode(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]!);
}

/** Whether `href` (decoded) is one the sanitizer may write: http(s) with a host, mailto, a local path or a fragment. */
function hrefAllowed(href: string): boolean {
  return /^https?:\/\/[^/\\]/.test(href) || href.startsWith('mailto:') || /^\/(?![/\\])/.test(href) || href.startsWith('#');
}

/** Every problem K14 and the output grammar find in `out`. */
function problems(out: string): string[] {
  const found: string[] = [];
  for (const banned of ['<script', '<svg', '<iframe', '<object', '<embed', '<math', '<style', '<base', '<meta', '<link', '<form']) {
    if (out.toLowerCase().includes(banned)) found.push(`contains ${banned}`);
  }
  let last = 0;
  for (const m of out.matchAll(TAG)) {
    const text = out.slice(last, m.index);
    if (!ESCAPED_TEXT.test(text)) found.push(`unescaped text ${JSON.stringify(text)}`);
    last = m.index + m[0].length;
    const [, closing, name, attrText] = m as unknown as [string, string, string, string];
    if (!ALLOWED_TAGS.has(name)) found.push(`tag ${name}`);
    if (closing && attrText) found.push(`attributes on </${name}>`);
    const attrs = [...attrText.matchAll(/ ([a-z]+)="([^"]*)"/g)].map(([, k, v]) => [k!, decode(v!)] as const);
    for (const [key, value] of attrs) {
      if (!(ATTRIBUTES_OF[name] ?? ['title']).includes(key)) found.push(`attribute ${key} on ${name}`);
      if (/^on/i.test(key) || key === 'style') found.push(`attribute ${key}`);
      if (key === 'href' && (!hrefAllowed(value) || /^\s*(?:javascript|vbscript|data):/i.test(value))) found.push(`href ${value}`);
      if (key === 'src' && !FILE_SRC.test(value)) found.push(`src ${value}`);
      if (key === 'rel' && value !== 'noopener nofollow') found.push(`rel ${value}`);
    }
    if (name === 'img' && !closing && !attrs.some(([k]) => k === 'src')) found.push('img without src');
  }
  const tail = out.slice(last);
  if (!ESCAPED_TEXT.test(tail)) found.push(`unescaped text ${JSON.stringify(tail)}`);
  return found;
}

/** The few DOM members these tests use (the core TypeScript project has no DOM library). */
interface DomElement {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly attributes: Iterable<{ readonly name: string; readonly value: string }>;
  innerHTML: string;
  readonly firstElementChild: DomElement | null;
  readonly children: { readonly length: number };
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): Iterable<DomElement>;
}
interface DomDocument {
  readonly body: DomElement;
  getElementById(id: string): DomElement | null;
}
type DomParserClass = new () => { parseFromString(source: string, type: 'text/html'): DomDocument };

/** jsdom's DOMParser (this file runs in the jsdom environment): a browser's HTML parser, scripting off. */
function parseDocument(html: string): DomDocument {
  const Parser = (globalThis as unknown as { DOMParser: DomParserClass }).DOMParser;
  return new Parser().parseFromString(html, 'text/html');
}

/** A container reused by the fuzz test: parsing into it (as inner HTML) is much cheaper than a new document. */
let fuzzContainer: DomElement | null = null;

/**
 * The output as a browser reads it inside a `<div>`: the problems found in the elements it builds, and the inner HTML
 * it serialises back. By default the output is parsed as part of a whole document, which also shows whether anything
 * gets out of the container; `fragment` parses it as the inner HTML of a reused `<div>` (the same reading, faster).
 */
function browserRead(out: string, fragment = false): { problems: string[]; serialized: string } {
  const found: string[] = [];
  let root: DomElement;
  if (fragment) {
    fuzzContainer ??= parseDocument('<div id="isi"></div>').getElementById('isi')!;
    root = fuzzContainer;
    root.innerHTML = out;
  } else {
    const doc = parseDocument(`<div id="isi">${out}</div>`);
    root = doc.getElementById('isi')!;
    if (doc.body.children.length !== 1 || doc.body.firstElementChild !== root) found.push('content left the container');
  }
  for (const el of root.querySelectorAll('*')) {
    const name = el.localName;
    if (!ALLOWED_TAGS.has(name) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') found.push(`element ${name}`);
    for (const attr of el.attributes) {
      if (!(ATTRIBUTES_OF[name] ?? ['title']).includes(attr.name)) found.push(`attribute ${attr.name} on ${name}`);
    }
    const href = el.getAttribute('href');
    if (href !== null && !hrefAllowed(href)) found.push(`href ${href}`);
    const src = el.getAttribute('src');
    if (name === 'img' && (src === null || !FILE_SRC.test(src))) found.push(`src ${String(src)}`);
  }
  return { problems: found, serialized: root.innerHTML };
}

/** Asserts K14, the grammar, the browser's reading and idempotence for one output of `input`. */
function expectSafe(out: string): void {
  expect(problems(out)).toEqual([]);
  const read = browserRead(out);
  expect(read.problems).toEqual([]);
  expect(sanitizedHtml(read.serialized)).toBe(out);
  expect(sanitizedHtml(out)).toBe(out);
}

/** A small deterministic generator (mulberry32), so a failing fuzz case can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_PIECES = [
  '<', '>', '</', '/', '=', '"', "'", '`', ' ', '\n', '\t', '&', '#', ';', 'x', '&#106;', '&#x3a;', '&colon;', '&lt;',
  'a', 'p', 'img', 'script', 'style', 'svg', 'math', 'table', 'tr', 'td', 'li', 'ul', 'pre', 'template', 'textarea',
  'title', 'noscript', 'iframe', 'href', 'src', 'onerror', 'onload', 'style=', 'javascript:', 'data:', 'alert(1)', '//',
  '\\', '<!--', '-->', '<![CDATA[', ']]>', '<!', '?', '/files/01HZY3V0ZQ7M4K2B6S9T1W8XEA', 'http://e.example/', 'mailto:',
  '*', '**', '[', ']', '(', ')', '![', '`', '```', '#', '- ', '1. ', '> ', '|', '---', 'b', 'strong',
];

function fuzzInput(next: () => number): string {
  const length = 1 + Math.floor(next() * 40);
  let out = '';
  for (let k = 0; k < length; k++) out += FUZZ_PIECES[Math.floor(next() * FUZZ_PIECES.length)];
  return out;
}

describe('the XSS corpus (K14)', () => {
  it('holds at least 150 self-written HTML vectors, and Markdown vectors besides', () => {
    expect(XSS_VECTORS.length).toBeGreaterThanOrEqual(150);
    expect(new Set(XSS_VECTORS).size).toBe(XSS_VECTORS.length);
    expect(MARKDOWN_XSS_VECTORS.length).toBeGreaterThanOrEqual(25);
  });

  it('the checks themselves catch executable markup (a self-test)', () => {
    expect(problems('<script>alert(1)</script>')).not.toEqual([]);
    expect(problems('<p onclick="alert(1)">x</p>')).not.toEqual([]);
    expect(problems('<a href="javascript:alert(1)">x</a>')).not.toEqual([]);
    expect(problems('<a href="//evil.example">x</a>')).not.toEqual([]);
    expect(problems('<img src="https://evil.example/x.png">')).not.toEqual([]);
    expect(problems('<p style="x">x</p>')).not.toEqual([]);
    expect(problems('a < b')).not.toEqual([]);
    // Markup a browser repairs (text a table cannot hold is moved in front of it) does not survive the round trip.
    const repaired = '<table><tbody><tr><td>a</td></tr></tbody>x</table>';
    expect(sanitizedHtml(browserRead(repaired).serialized)).not.toBe(repaired);
    expect(browserRead('<svg><a href="javascript:alert(1)">x</a></svg>').problems).not.toEqual([]);
  });
});

describe('sanitizedHtml on the corpus', () => {
  it.each(XSS_VECTORS.map((v) => [v]))('%j leaves no executable markup', (vector) => {
    expectSafe(sanitizedHtml(vector));
  });
});

describe('renderMarkdown on the corpus', () => {
  it.each([...MARKDOWN_XSS_VECTORS, ...XSS_VECTORS].map((v) => [v]))('%j leaves no executable markup', (vector) => {
    expectSafe(renderMarkdown(vector));
  });
});

describe('S7: no corpus link leaves the site in disguise or runs script', () => {
  it.each([
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '\\/evil.example',
    'jav&#x09;ascript:alert(1)',
    'java\nscript:alert(1)',
    '&#106;avascript:alert(1)',
    ' javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'http:evil.example',
  ])('href %j is dropped', (href) => {
    const out = sanitizedHtml(`<a href="${href}">x</a>`);
    expect(out).toBe('<a>x</a>');
    // In Markdown a backslash escapes punctuation (`\\x` is `\x`, `\/` is `/`), so some of these become local paths:
    // whatever href is left must be one.
    const md = renderMarkdown(`[x](${href.replace('\n', '')})`);
    expect(problems(md)).toEqual([]);
    for (const [, value] of md.matchAll(/href="([^"]*)"/g)) expect(value).toMatch(/^\/(?![/\\])/);
  });

  it('src /files/<ulid>/../x is dropped, and /halaman/a?b=1#c stays as it is', () => {
    expect(sanitizedHtml('<img src="/files/01HZY3V0ZQ7M4K2B6S9T1W8XEA/../x" alt="x">')).toBe('');
    expect(sanitizedHtml('<a href="/halaman/a?b=1#c">x</a>')).toBe('<a href="/halaman/a?b=1#c">x</a>');
    expect(renderMarkdown('[x](/halaman/a?b=1#c)')).toBe('<p><a href="/halaman/a?b=1#c">x</a></p>');
  });
});

describe('fuzz', () => {
  it('2 000 random mixes of markup pieces stay safe and idempotent, through both entry points', () => {
    const next = random(20261030);
    for (let k = 0; k < 2_000; k++) {
      const input = fuzzInput(next);
      for (const out of [sanitizedHtml(input), renderMarkdown(input)]) {
        const read = browserRead(out, true);
        const found = [...problems(out), ...read.problems];
        const again = sanitizedHtml(out);
        const browser = sanitizedHtml(read.serialized);
        // One assertion per failing case (not 8 000 passing ones), with everything needed to replay it.
        if (found.length > 0 || again !== out || browser !== out) expect({ input, out, found, again, browser }).toBeNull();
      }
    }
  }, 30_000);
});
