// Our own XML writer (spec §10 and the Global Constraints "XML output"): OAI-PMH, MARCXML, RSS and sitemaps. It escapes
// every text and attribute value and drops the characters XML 1.0 forbids, so a stray control character in catalogue
// data can never make a harvester reject the whole response. Pure; no I/O.

import { isXmlName } from './reader.js';

/** Attribute values; a null or undefined value leaves the attribute out. */
type XmlAttrs = Readonly<Record<string, string | number | null | undefined>>;

/** Everything except XML 1.0 `Char`: C0 controls other than TAB/LF/CR, lone surrogates, U+FFFE and U+FFFF. */
const INVALID_XML_CHARS_RE = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

const TEXT_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '&#13;' };
const ATTR_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};

/** Removes every character XML 1.0 does not allow (C0 controls except TAB/LF/CR, lone surrogates, U+FFFE, U+FFFF). */
export function stripInvalidXmlChars(s: string): string {
  return s.replace(INVALID_XML_CHARS_RE, '');
}

/**
 * Text content: forbidden characters dropped, `& < > "` escaped (`>` so that `]]>` cannot appear), and CR written as
 * `&#13;` so that a reader's line-end normalisation keeps it.
 */
export function xmlEscape(s: string): string {
  return stripInvalidXmlChars(s).replace(/[&<>"\r]/g, (c) => TEXT_ESCAPES[c] ?? c);
}

/**
 * An attribute value (for either quote): forbidden characters dropped, `& < > " '` escaped, and TAB, LF and CR written
 * as character references so that a reader's attribute-value normalisation keeps them.
 */
export function xmlAttr(s: string): string {
  return stripInvalidXmlChars(s).replace(/[&<>"'\t\n\r]/g, (c) => ATTR_ESCAPES[c] ?? c);
}

function checkName(name: string): void {
  if (!isXmlName(name)) throw new Error(`XmlWriter: ${JSON.stringify(name.slice(0, 40))} is not an XML name`);
}

function renderAttrs(attrs: XmlAttrs | undefined): string {
  if (!attrs) return '';
  let out = '';
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    checkName(name);
    out += ` ${name}="${xmlAttr(String(value))}"`;
  }
  return out;
}

/**
 * Builds an XML document in memory. Element and attribute names come from code and are checked (an invalid name
 * throws); text and attribute values are always escaped. raw() appends trusted XML that our own code produced (for
 * instance a MARCXML record inside an OAI response) as is. toString() throws while an element is still open.
 */
export class XmlWriter {
  private readonly parts: string[] = [];
  private readonly stack: string[] = [];

  open(name: string, attrs?: XmlAttrs): this {
    checkName(name);
    this.parts.push(`<${name}${renderAttrs(attrs)}>`);
    this.stack.push(name);
    return this;
  }

  text(s: string | number): this {
    this.parts.push(xmlEscape(String(s)));
    return this;
  }

  close(): this {
    const name = this.stack.pop();
    if (name === undefined) throw new Error('XmlWriter: close() without an open element');
    this.parts.push(`</${name}>`);
    return this;
  }

  /** `<name attrs>text</name>`, or `<name attrs/>` when the text is empty. */
  leaf(name: string, text: string | number, attrs?: XmlAttrs): this {
    checkName(name);
    const escaped = xmlEscape(String(text));
    const head = `${name}${renderAttrs(attrs)}`;
    this.parts.push(escaped === '' ? `<${head}/>` : `<${head}>${escaped}</${name}>`);
    return this;
  }

  /** Appends `trustedXml` unchanged. Never pass it data from outside: that goes through text() or attributes. */
  raw(trustedXml: string): this {
    this.parts.push(trustedXml);
    return this;
  }

  toString(): string {
    if (this.stack.length > 0) throw new Error(`XmlWriter: ${this.stack.length} element(s) still open`);
    return this.parts.join('');
  }
}
