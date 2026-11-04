import { htmlTokenize, type HtmlToken } from './tokenizer.js';

/**
 * HTML that went through {@link sanitizedHtml} (or `renderMarkdown`, which ends there): the only kind of HTML that may
 * reach a page unescaped, and only through the OPAC's `safeHtml` (S6). A brand on `string`, so a plain string needs a
 * visible cast to pass for one.
 */
export type SafeHtml = string & { readonly __safeHtml: true };

type Attributes = Extract<HtmlToken, { type: 'start' }>['attrs'];

/** The tags that survive (spec §9.5). */
const ALLOWED = new Set([
  'p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'img', 'table', 'thead',
  'tbody', 'tr', 'th', 'td', 'hr', 'code', 'pre', 'figure', 'figcaption',
]);

/**
 * Tags written as an allowed one, so that their meaning survives (content migrated from SLiMS is full of them): the
 * old bold and italic, h1 (the page title is the page's own h1) and h5/h6, and the block containers as paragraphs.
 */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['b', 'strong'], ['i', 'em'], ['strike', 's'], ['del', 's'], ['ins', 'u'], ['h1', 'h2'], ['h5', 'h4'], ['h6', 'h4'],
  ['tfoot', 'tbody'],
  ...['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'address', 'center', 'dt', 'dd'].map(
    (name): [string, string] => [name, 'p'],
  ),
]);

/** Elements whose text a browser never shows: their text is dropped, not kept. */
const UNSHOWN_TEXT = new Set(['script', 'style', 'title', 'iframe', 'noembed', 'noframes', 'noscript']);
/** An inert subtree a browser never shows: everything up to its end tag is dropped. */
const UNSHOWN_SUBTREE = 'template';

const VOID = new Set(['br', 'hr', 'img']);
/** Inline elements that hold text (`a` has its own rules). */
const INLINE = new Set(['strong', 'em', 'u', 's', 'code']);
/** Elements that hold blocks and text. */
const FLOW = new Set(['li', 'blockquote', 'figure', 'figcaption', 'td', 'th']);
/** Elements that hold only text and inline elements: a block start closes them. */
const PHRASING_ONLY = new Set(['p', 'h2', 'h3', 'h4', 'pre', 'a', ...INLINE]);
const LISTS = new Set(['ul', 'ol']);
/** Elements that hold only elements: text between them is dropped when it is white space, else wrapped. */
const STRUCTURE = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tr']);
const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tr']);
const TABLE_ELEMENTS = new Set([...TABLE_PARTS, 'td', 'th']);

/**
 * The deepest nesting written: a start tag beyond it is dropped (its text kept). A browser would build any depth; a
 * page needs far less, and a bound keeps every walk of the open elements short.
 */
const MAX_DEPTH = 100;

/** The base relative links are resolved against (S7): a host that never resolves (RFC 2606). */
const LINK_BASE = 'https://x.invalid/';
const LINK_BASE_ORIGIN = 'https://x.invalid';
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** `http:` or `https:` followed by two slashes (either way round): an absolute link whatever the page's scheme. */
const WITH_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:[\\/]{2}/;
const FILE_SRC = /^\/files\/[0-9A-HJKMNP-TV-Z]{26}$/;

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `&`, `<`, `>`, `"` and `'` as references: safe in text and in a double-quoted attribute. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** `text` without control characters: C0 except TAB, LF and FF, and DEL. */
function withoutControls(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c) || c === 0x7f) {
      out += text.slice(from, i);
      from = i + 1;
    }
  }
  return from === 0 ? text : out + text.slice(from);
}

/** A URL attribute as S7 reads it: every C0 control (TAB, CR and LF included) removed, spaces trimmed at both ends. */
function urlInput(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) >= 0x20) out += value[i];
  // By hand: `/ +$/` backtracks over every inner run of spaces (quadratic on a long one).
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === ' ') start++;
  while (end > start && out[end - 1] === ' ') end--;
  return out.slice(start, end);
}

/** `value` resolved against {@link LINK_BASE}, or null when it is no URL. */
function resolve(value: string): URL | null {
  try {
    return new URL(value, LINK_BASE);
  } catch {
    return null;
  }
}

/**
 * The `href` to write for `raw` (S7), normalised, never as written; null when the link must lose it.
 * - An absolute link (one with a scheme) must be `mailto:`, or `http:`/`https:` with `//` and no user name or
 *   password. `http:host` is refused: a browser reads it against the page's own scheme, as another host or a path.
 * - A relative link must stay on {@link LINK_BASE}'s host, which refuses `//host`, `/\host`, `\\host` and `\/host`,
 *   and its path must not start with `//` (where `/.//host` lands). It is written as path + query + fragment; a
 *   fragment alone stays a fragment.
 */
function safeHref(raw: string | undefined): { value: string; absolute: boolean } | null {
  if (raw === undefined) return null;
  const value = urlInput(raw);
  if (value === '') return null;
  const url = resolve(value);
  if (url === null) return null;
  if (SCHEME.test(value)) {
    if (url.protocol === 'mailto:') return { value: url.href, absolute: true };
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!WITH_AUTHORITY.test(value) || url.username !== '' || url.password !== '') return null;
    return { value: url.href, absolute: true };
  }
  if (url.origin !== LINK_BASE_ORIGIN || url.pathname.startsWith('//')) return null;
  if (value.startsWith('#')) return { value: url.hash === '' ? '#' : url.hash, absolute: false };
  return { value: url.pathname + url.search + url.hash, absolute: false };
}

/** The `src` to write for `raw`: `/files/<ulid>` once normalised (S7), else null. */
function safeSrc(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const value = urlInput(raw);
  if (value === '' || SCHEME.test(value)) return null;
  const url = resolve(value);
  if (url === null || url.origin !== LINK_BASE_ORIGIN) return null;
  const local = url.pathname + url.search + url.hash;
  return FILE_SRC.test(local) ? local : null;
}

function attribute(attrs: Attributes, name: string): string | undefined {
  return attrs.find(([key]) => key === name)?.[1];
}

/** ` title="…"` when the tag has a title, else nothing. */
function titleOf(attrs: Attributes): string {
  const title = attribute(attrs, 'title');
  return title === undefined ? '' : ` title="${escapeHtml(withoutControls(title))}"`;
}

function isWhiteSpace(text: string): boolean {
  return /^[ \t\n\f]*$/.test(text);
}

interface OpenElement {
  readonly name: string;
  /** The start tag as it will be written. */
  readonly tag: string;
  /** Opened by the builder itself (a list around a stray item), not by a tag of the input. */
  readonly implicit: boolean;
}

/**
 * The output, built from tokens with a stack of open elements. It keeps a small content model that every browser
 * parses without repair (no block in a paragraph, no text in a table outside a cell, no link in a link), so that the
 * page shows what was written and the output is a fixed point. A start tag is written only once something goes into
 * its element, so empty elements disappear (an explicit table cell is written at once: an empty cell keeps the grid).
 */
class Builder {
  private readonly stack: OpenElement[] = [];
  /** How many elements, from the bottom of the stack, have their start tag written. */
  private written = 0;
  private out = '';

  current(): string | undefined {
    return this.stack.at(-1)?.name;
  }

  text(raw: string): void {
    const text = withoutControls(raw);
    if (text === '') return;
    const top = this.stack.at(-1);
    if (top !== undefined && STRUCTURE.has(top.name) && isWhiteSpace(text)) return;
    if (!this.toPhrasing()) return;
    // A browser drops a line feed right after <pre>; one written first keeps the text's own (and the output stable).
    const lead = this.current() === 'pre' && this.written < this.stack.length && text.startsWith('\n') ? '\n' : '';
    this.content(lead + escapeHtml(text));
  }

  start(name: string, attrs: Attributes): void {
    switch (name) {
      case 'li':
        return this.startItem(attrs);
      case 'tr':
        return this.startRow(attrs);
      case 'td':
      case 'th':
        return this.startCell(name, attrs);
      case 'thead':
      case 'tbody':
        return this.startSection(name, attrs);
      case 'figcaption':
        return this.startCaption(attrs);
      case 'a':
        return this.startLink(attrs);
      case 'img':
        return this.image(attrs);
      case 'br':
        if (this.toPhrasing()) this.content(`<br${titleOf(attrs)}>`);
        return;
      case 'hr':
        if (this.toFlow()) this.content(`<hr${titleOf(attrs)}>`);
        return;
      default:
        if (INLINE.has(name) ? this.toPhrasing() : this.toFlow()) this.push(name, `<${name}${titleOf(attrs)}>`);
    }
  }

  end(name: string): void {
    if (VOID.has(name)) return;
    // A table's own end tags cross its cells; any other end tag stops at a cell or a table, as in a browser.
    const tableScope = TABLE_ELEMENTS.has(name);
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const open = this.stack[k]!.name;
      if (open === name) return this.popTo(k);
      if (open === 'table' || (!tableScope && (open === 'td' || open === 'th'))) return;
    }
  }

  finish(): string {
    this.popTo(0);
    return this.out;
  }

  private push(name: string, tag: string, implicit = false): boolean {
    if (this.stack.length >= MAX_DEPTH) return false;
    this.stack.push({ name, tag, implicit });
    return true;
  }

  private flush(): void {
    for (let k = this.written; k < this.stack.length; k++) this.out += this.stack[k]!.tag;
    this.written = this.stack.length;
  }

  private pop(): void {
    const element = this.stack.pop()!;
    if (this.written > this.stack.length) {
      this.out += `</${element.name}>`;
      this.written = this.stack.length;
    }
  }

  private popTo(depth: number): void {
    while (this.stack.length > depth) this.pop();
  }

  private content(markup: string): void {
    this.flush();
    this.out += markup;
  }

  /** Makes the current element one that holds blocks: closes text-only ones, opens an item or a cell. */
  private toFlow(): boolean {
    for (;;) {
      const top = this.stack.at(-1);
      if (top === undefined || FLOW.has(top.name)) return true;
      if (PHRASING_ONLY.has(top.name) || (LISTS.has(top.name) && top.implicit)) {
        this.pop();
        continue;
      }
      if (LISTS.has(top.name)) return this.push('li', '<li>', true);
      const next = top.name === 'table' ? 'tbody' : top.name === 'tr' ? 'td' : 'tr';
      if (!this.push(next, `<${next}>`, true)) return false;
      if (next === 'td') return true;
    }
  }

  /** Makes the current element one that holds text. */
  private toPhrasing(): boolean {
    const top = this.stack.at(-1);
    if (top === undefined || FLOW.has(top.name) || PHRASING_ONLY.has(top.name)) return true;
    return this.toFlow();
  }

  /** The index of the innermost open element that is not text-only, or -1 for the root. */
  private innermostContainer(): number {
    let k = this.stack.length - 1;
    while (k >= 0 && PHRASING_ONLY.has(this.stack[k]!.name)) k--;
    return k;
  }

  /** The index of the innermost open table, table section or row, or -1. */
  private innermostTablePart(): number {
    for (let k = this.stack.length - 1; k >= 0; k--) if (TABLE_PARTS.has(this.stack[k]!.name)) return k;
    return -1;
  }

  private startItem(attrs: Attributes): void {
    const k = this.innermostContainer();
    const at = k >= 0 ? this.stack[k]!.name : undefined;
    if (at === 'li') {
      this.popTo(k);
    } else if (at !== undefined && LISTS.has(at)) {
      this.popTo(k + 1);
    } else {
      this.popTo(k + 1);
      if (!this.toFlow() || !this.push('ul', '<ul>', true)) return;
    }
    this.push('li', `<li${titleOf(attrs)}>`);
  }

  private startRow(attrs: Attributes): void {
    const k = this.innermostTablePart();
    if (k < 0) return;
    const at = this.stack[k]!.name;
    if (at === 'tr') {
      this.popTo(k);
    } else {
      this.popTo(k + 1);
      if (at === 'table' && !this.push('tbody', '<tbody>', true)) return;
    }
    this.push('tr', `<tr${titleOf(attrs)}>`);
  }

  private startCell(name: string, attrs: Attributes): void {
    const k = this.innermostTablePart();
    if (k < 0) return;
    this.popTo(k + 1);
    const at = this.stack[k]!.name;
    if (at === 'table' && !this.push('tbody', '<tbody>', true)) return;
    if (at !== 'tr' && !this.push('tr', '<tr>', true)) return;
    if (this.push(name, `<${name}${titleOf(attrs)}>`)) this.flush();
  }

  private startSection(name: string, attrs: Attributes): void {
    const k = this.stack.findLastIndex((element) => element.name === 'table');
    if (k < 0) return;
    this.popTo(k + 1);
    this.push(name, `<${name}${titleOf(attrs)}>`);
  }

  private startCaption(attrs: Attributes): void {
    const k = this.innermostContainer();
    if (k < 0 || this.stack[k]!.name !== 'figure') return;
    this.popTo(k + 1);
    this.push('figcaption', `<figcaption${titleOf(attrs)}>`);
  }

  private startLink(attrs: Attributes): void {
    const open = this.stack.findLastIndex((element) => element.name === 'a');
    if (open >= 0) this.popTo(open);
    if (!this.toPhrasing()) return;
    const href = safeHref(attribute(attrs, 'href'));
    let tag = '<a';
    if (href !== null) tag += ` href="${escapeHtml(href.value)}"${href.absolute ? ' rel="noopener nofollow"' : ''}`;
    this.push('a', `${tag}${titleOf(attrs)}>`);
  }

  private image(attrs: Attributes): void {
    const src = safeSrc(attribute(attrs, 'src'));
    if (src === null || !this.toPhrasing()) return;
    const alt = attribute(attrs, 'alt');
    const altAttr = alt === undefined ? '' : ` alt="${escapeHtml(withoutControls(alt))}"`;
    this.content(`<img src="${escapeHtml(src)}"${altAttr}${titleOf(attrs)}>`);
  }
}

/**
 * User HTML made safe (spec §9.5): an allowlist of tags (`p br h2 h3 h4 strong em u s a ul ol li blockquote img table
 * thead tbody tr th td hr code pre figure figcaption`) and attributes (`href`, `src`, `alt`, `title`), with the output
 * rebuilt from the tokens of a lenient tokenizer: tags lower-cased, attributes double-quoted, all text escaped.
 * - `href` (S7): character references decoded, C0 controls removed and spaces trimmed, resolved against a fixed base;
 *   http, https, mailto or a link on the site, written normalised. An absolute link gets `rel="noopener nofollow"`.
 * - `src`: only `/files/<ulid>`, checked on the normalised value; an `img` without one is dropped.
 * - Any other tag is dropped and its text kept (a few old or container tags are written as their allowed
 *   counterpart, `b` as `strong`, `div` as `p`); the text of `script`, `style` and the other elements a browser never
 *   shows is dropped with them. Comments go; unclosed tags are closed; elements left empty are dropped.
 *
 * Stored sanitized, and sanitized again at render. Idempotent: `sanitizedHtml(sanitizedHtml(x)) === sanitizedHtml(x)`.
 */
export function sanitizedHtml(html: string): SafeHtml {
  const builder = new Builder();
  let skipped = 0;
  let afterPre = false;
  for (const token of htmlTokenize(html)) {
    const dropNewline = afterPre;
    afterPre = false;
    if (skipped > 0) {
      if (token.type === 'start' && token.name === UNSHOWN_SUBTREE) skipped++;
      else if (token.type === 'end' && token.name === UNSHOWN_SUBTREE) skipped--;
      continue;
    }
    if (token.type === 'text') {
      if (token.rawOf !== null && UNSHOWN_TEXT.has(token.rawOf)) continue;
      builder.text(dropNewline && token.text.startsWith('\n') ? token.text.slice(1) : token.text);
    } else if (token.type === 'start') {
      if (token.name === UNSHOWN_SUBTREE) {
        skipped = 1;
        continue;
      }
      const name = ALIASES.get(token.name) ?? token.name;
      if (!ALLOWED.has(name)) continue;
      builder.start(name, token.attrs);
      afterPre = name === 'pre' && builder.current() === 'pre';
    } else if (token.type === 'end') {
      // `</br>` is a line break, as a browser reads it.
      if (token.name === 'br') builder.start('br', []);
      const name = ALIASES.get(token.name) ?? token.name;
      if (ALLOWED.has(name)) builder.end(name);
    }
  }
  return builder.finish() as SafeHtml;
}
