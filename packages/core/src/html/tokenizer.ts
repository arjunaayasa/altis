/**
 * A lenient HTML tokenizer for the sanitizer (spec §9.5; Phase 2 Task 8), written from the WHATWG tokenization rules
 * in the parts that decide where markup starts and ends:
 * - start and end tags (names and attribute names lower-cased in ASCII, the first of two equal attributes kept),
 *   quoted, unquoted and missing attribute values, `/` between attributes;
 * - comments (`<!--`, `<!-->`, `--!>`), bogus comments (`<!…>`, `<?…>`, `</ …>`), DOCTYPE and CDATA as comments;
 * - the raw-text elements (`script`, `style`, `xmp`, `iframe`, `noembed`, `noframes`, `noscript`), the escapable
 *   raw-text ones (`textarea`, `title`) and `plaintext`, whose content is text up to the matching end tag;
 * - character references, named and numeric, with or without `;`, with HTML's attribute rule for a legacy name.
 *
 * It never throws and never refuses: what is not markup is text, and a tag cut off by the end of the input is dropped
 * (as a browser drops it). Before tokenizing, CR LF and CR become LF, NUL is removed and a lone surrogate becomes
 * U+FFFD. The work is linear in the input: every scan moves forward.
 *
 * Internal to `html/` (M14): the sanitizer is its one caller.
 */

/** One token: decoded text (with the raw-text element it came from), a start tag, an end tag, or a comment. */
export type HtmlToken =
  | { readonly type: 'text'; readonly text: string; readonly rawOf: string | null }
  | {
      readonly type: 'start';
      readonly name: string;
      readonly attrs: readonly (readonly [name: string, value: string])[];
      readonly selfClosing: boolean;
    }
  | { readonly type: 'end'; readonly name: string }
  | { readonly type: 'comment' };

/** Elements whose content is text up to their end tag, not decoded. */
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
/** Elements whose content is text up to their end tag, with character references decoded. */
const ESCAPABLE_RAW_TEXT = new Set(['textarea', 'title']);

const REPLACEMENT = String.fromCharCode(0xfffd);

/** The 96 names of U+00A0…U+00FF, in code point order; HTML also reads each of them without `;`. */
const LATIN1_NAMES = [
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr',
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest',
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml',
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig',
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml',
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml',
]
  .join(' ')
  .split(' ');

/** The other names HTML reads without `;` (with the Latin-1 ones, its 106 legacy names). */
const LEGACY_EXTRA = 'amp:26 AMP:26 lt:3C LT:3C gt:3E GT:3E quot:22 QUOT:22 COPY:A9 REG:AE';

/**
 * Names read only with `;`: the HTML 4 set (Latin Extended, Greek, punctuation, arrows, mathematics) and HTML's names
 * for ASCII punctuation. A name not listed here stays text, as written.
 */
const SEMICOLON_ONLY = [
  'Tab:9 NewLine:A excl:21 num:23 dollar:24 percnt:25 apos:27 lpar:28 rpar:29 ast:2A midast:2A plus:2B comma:2C',
  'period:2E sol:2F colon:3A semi:3B equals:3D quest:3F commat:40 lsqb:5B lbrack:5B bsol:5C rsqb:5D rbrack:5D',
  'Hat:5E lowbar:5F UnderBar:5F grave:60 DiacriticalGrave:60 lcub:7B lbrace:7B verbar:7C vert:7C VerticalLine:7C',
  'rcub:7D rbrace:7D NonBreakingSpace:A0',
  'OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 fnof:192 circ:2C6 tilde:2DC',
  'Alpha:391 Beta:392 Gamma:393 Delta:394 Epsilon:395 Zeta:396 Eta:397 Theta:398 Iota:399 Kappa:39A Lambda:39B',
  'Mu:39C Nu:39D Xi:39E Omicron:39F Pi:3A0 Rho:3A1 Sigma:3A3 Tau:3A4 Upsilon:3A5 Phi:3A6 Chi:3A7 Psi:3A8 Omega:3A9',
  'alpha:3B1 beta:3B2 gamma:3B3 delta:3B4 epsilon:3B5 zeta:3B6 eta:3B7 theta:3B8 iota:3B9 kappa:3BA lambda:3BB',
  'mu:3BC nu:3BD xi:3BE omicron:3BF pi:3C0 rho:3C1 sigmaf:3C2 sigma:3C3 tau:3C4 upsilon:3C5 phi:3C6 chi:3C7',
  'psi:3C8 omega:3C9 thetasym:3D1 upsih:3D2 piv:3D6',
  'ensp:2002 emsp:2003 thinsp:2009 ZeroWidthSpace:200B zwnj:200C zwj:200D lrm:200E rlm:200F hyphen:2010 dash:2010',
  'ndash:2013 mdash:2014 horbar:2015 Verbar:2016 lsquo:2018 rsquo:2019 sbquo:201A ldquo:201C rdquo:201D bdquo:201E',
  'dagger:2020 Dagger:2021 bull:2022 bullet:2022 nldr:2025 hellip:2026 mldr:2026 permil:2030 prime:2032 Prime:2033',
  'lsaquo:2039 rsaquo:203A oline:203E frasl:2044 euro:20AC image:2111 weierp:2118 real:211C trade:2122 TRADE:2122',
  'alefsym:2135 larr:2190 uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21B5 lArr:21D0 uArr:21D1 rArr:21D2',
  'dArr:21D3 hArr:21D4 forall:2200 part:2202 exist:2203 empty:2205 nabla:2207 isin:2208 notin:2209 ni:220B',
  'prod:220F sum:2211 minus:2212 lowast:2217 radic:221A prop:221D infin:221E ang:2220 and:2227 or:2228 cap:2229',
  'cup:222A int:222B there4:2234 sim:223C cong:2245 asymp:2248 ne:2260 equiv:2261 le:2264 ge:2265 sub:2282',
  'sup:2283 nsub:2284 sube:2286 supe:2287 oplus:2295 otimes:2297 perp:22A5 sdot:22C5 lceil:2308 rceil:2309',
  'lfloor:230A rfloor:230B lang:27E8 rang:27E9 loz:25CA spades:2660 clubs:2663 hearts:2665 diams:2666',
].join(' ');

/** `name:hex …` as [name, character] pairs. */
function namePairs(list: string): [string, string][] {
  return list.split(' ').map((entry) => {
    const [name, hex] = entry.split(':') as [string, string];
    return [name, String.fromCodePoint(Number.parseInt(hex, 16))];
  });
}

/** Every named reference this tokenizer knows, read with `;`. */
const NAMED: ReadonlyMap<string, string> = new Map([
  ...LATIN1_NAMES.map((name, k): [string, string] => [name, String.fromCharCode(0xa0 + k)]),
  ...namePairs(LEGACY_EXTRA),
  ...namePairs(SEMICOLON_ONLY),
]);

/** The legacy names, read without `;` too. */
const LEGACY: ReadonlySet<string> = new Set([...LATIN1_NAMES, ...namePairs(LEGACY_EXTRA).map(([name]) => name)]);
const LEGACY_MAX = 6;
const NAME_MAX = 32;

/** HTML's reading of a numeric reference to U+0080…U+009F (Windows-1252), where it differs. */
const C1_WINDOWS_1252: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021],
  [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018],
  [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc],
  [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);

const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const EQUALS = 0x3d;
const HASH = 0x23;
const SEMICOLON = 0x3b;

function isAsciiAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isAsciiDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isAsciiAlphanumeric(c: number): boolean {
  return isAsciiAlpha(c) || isAsciiDigit(c);
}

function isHexDigit(c: number): boolean {
  return isAsciiDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/** HTML's white space inside a tag: TAB, LF, FF and space (CR is gone after preprocessing). */
function isTagSpace(c: number): boolean {
  return c === 0x09 || c === 0x0a || c === 0x0c || c === 0x20;
}

/** Upper-case ASCII letters to lower case, nothing else (`İ` stays). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** CR LF and CR → LF, NUL removed, a lone surrogate → U+FFFD. */
function preprocess(input: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x0d) {
      out += `${input.slice(from, i)}\n`;
      if (input.charCodeAt(i + 1) === 0x0a) i++;
      from = i + 1;
    } else if (c === 0) {
      out += input.slice(from, i);
      from = i + 1;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff && (input.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        i++;
      } else {
        out += input.slice(from, i) + REPLACEMENT;
        from = i + 1;
      }
    }
  }
  return out + input.slice(from);
}

/** The character of a numeric reference, by HTML's rules (0, surrogates and > U+10FFFF are U+FFFD). */
function numericCharacter(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(C1_WINDOWS_1252.get(code) ?? code);
}

/** The reference whose `&` is at `amp`: its text and where it ends, or null when `&` is just an ampersand. */
function readReference(t: string, amp: number, inAttribute: boolean): { value: string; end: number } | null {
  const p = amp + 1;
  if (t.charCodeAt(p) === HASH) {
    let q = p + 1;
    const hex = t.charCodeAt(q) === 0x78 || t.charCodeAt(q) === 0x58;
    if (hex) q++;
    const digitsFrom = q;
    let code = 0;
    for (; q < t.length; q++) {
      const c = t.charCodeAt(q);
      if (hex ? !isHexDigit(c) : !isAsciiDigit(c)) break;
      // Past U+10FFFF the value only has to stay past it; capping keeps it a small integer.
      code = Math.min(code * (hex ? 16 : 10) + Number.parseInt(t[q]!, 16), 0x110000);
    }
    if (q === digitsFrom) return null;
    if (t.charCodeAt(q) === SEMICOLON) q++;
    return { value: numericCharacter(code), end: q };
  }
  let q = p;
  while (q < t.length && q - p < NAME_MAX && isAsciiAlphanumeric(t.charCodeAt(q))) q++;
  if (q === p) return null;
  const name = t.slice(p, q);
  if (t.charCodeAt(q) === SEMICOLON) {
    const value = NAMED.get(name);
    if (value !== undefined) return { value, end: q + 1 };
  }
  for (let length = Math.min(name.length, LEGACY_MAX); length >= 2; length--) {
    const legacy = name.slice(0, length);
    if (!LEGACY.has(legacy)) continue;
    const next = t.charCodeAt(p + length);
    // HTML's attribute rule: `?a=1&copy=2` keeps `&copy` as written.
    if (inAttribute && (next === EQUALS || isAsciiAlphanumeric(next))) return null;
    return { value: NAMED.get(legacy)!, end: p + length };
  }
  return null;
}

/** `text` with its character references decoded (one pass: `&amp;lt;` is `&lt;`). */
function decodeReferences(text: string, inAttribute: boolean): string {
  let amp = text.indexOf('&');
  if (amp < 0) return text;
  let out = '';
  let from = 0;
  while (amp >= 0) {
    const ref = readReference(text, amp, inAttribute);
    if (ref === null) {
      amp = text.indexOf('&', amp + 1);
    } else {
      out += text.slice(from, amp) + ref.value;
      from = ref.end;
      amp = text.indexOf('&', ref.end);
    }
  }
  return out + text.slice(from);
}

interface TagRead {
  readonly name: string;
  readonly attrs: (readonly [string, string])[];
  readonly selfClosing: boolean;
  readonly end: number;
}

/** The tag whose name starts at `p`, or null when the input ends inside it. */
function readTag(s: string, p: number): TagRead | null {
  const n = s.length;
  let j = p;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isTagSpace(c) || c === SLASH || c === GT) break;
    j++;
  }
  const name = asciiLower(s.slice(p, j));
  const attrs: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  for (;;) {
    while (j < n && isTagSpace(s.charCodeAt(j))) j++;
    if (j >= n) return null;
    const c = s.charCodeAt(j);
    if (c === GT) return { name, attrs, selfClosing: false, end: j + 1 };
    if (c === SLASH) {
      j++;
      if (j >= n) return null;
      if (s.charCodeAt(j) === GT) return { name, attrs, selfClosing: true, end: j + 1 };
      continue;
    }
    // An attribute name: its first character may be `=`, its others are anything but space, `/`, `>` and `=`.
    const nameFrom = j;
    j++;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isTagSpace(d) || d === SLASH || d === GT || d === EQUALS) break;
      j++;
    }
    const attrName = asciiLower(s.slice(nameFrom, j));
    while (j < n && isTagSpace(s.charCodeAt(j))) j++;
    if (j >= n) return null;
    let value = '';
    if (s.charCodeAt(j) === EQUALS) {
      j++;
      while (j < n && isTagSpace(s.charCodeAt(j))) j++;
      if (j >= n) return null;
      const q = s[j];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, j + 1);
        if (close < 0) return null;
        value = decodeReferences(s.slice(j + 1, close), true);
        j = close + 1;
      } else if (s.charCodeAt(j) !== GT) {
        const from = j;
        while (j < n && !isTagSpace(s.charCodeAt(j)) && s.charCodeAt(j) !== GT) j++;
        value = decodeReferences(s.slice(from, j), true);
      }
    }
    if (!seen.has(attrName)) {
      seen.add(attrName);
      attrs.push([attrName, value]);
    }
  }
}

/** Where the comment whose text starts at `p` (after `<!--`) ends. */
function commentEnd(s: string, p: number): number {
  if (s.charCodeAt(p) === GT) return p + 1;
  if (s.startsWith('->', p)) return p + 2;
  let k = s.indexOf('--', p);
  while (k >= 0) {
    if (s.charCodeAt(k + 2) === GT) return k + 3;
    if (s.charCodeAt(k + 2) === BANG && s.charCodeAt(k + 3) === GT) return k + 4;
    k = s.indexOf('--', k + 1);
  }
  return s.length;
}

/** Where the raw text of `name`, starting at `from`, ends: at its end tag (`</name` + space, `/` or `>`), or the end. */
function rawTextEnd(s: string, from: number, name: string): number {
  if (name === 'plaintext') return s.length;
  let k = s.indexOf('</', from);
  while (k >= 0) {
    const after = k + 2 + name.length;
    if (asciiLower(s.slice(k + 2, after)) === name) {
      const c = s.charCodeAt(after);
      if (isTagSpace(c) || c === SLASH || c === GT) return k;
    }
    k = s.indexOf('</', k + 2);
  }
  return s.length;
}

/** Where the bogus comment starting at `p` ends: after the next `>`, or at the end. */
function bogusCommentEnd(s: string, p: number): number {
  const gt = s.indexOf('>', p);
  return gt < 0 ? s.length : gt + 1;
}

/** The tokens of `html`. */
export function htmlTokenize(html: string): HtmlToken[] {
  const s = preprocess(html);
  const n = s.length;
  const tokens: HtmlToken[] = [];
  let textFrom = 0;
  let i = 0;
  const pushText = (to: number): void => {
    if (to > textFrom) tokens.push({ type: 'text', text: decodeReferences(s.slice(textFrom, to), false), rawOf: null });
  };
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    const next = s.charCodeAt(lt + 1);
    if (isAsciiAlpha(next)) {
      pushText(lt);
      const tag = readTag(s, lt + 1);
      if (tag === null) {
        // The input ends inside the tag: a browser drops it, and so does this.
        textFrom = n;
        break;
      }
      tokens.push({ type: 'start', name: tag.name, attrs: tag.attrs, selfClosing: tag.selfClosing });
      textFrom = i = tag.end;
      const raw = RAW_TEXT.has(tag.name) || ESCAPABLE_RAW_TEXT.has(tag.name) || tag.name === 'plaintext';
      if (raw) {
        const end = rawTextEnd(s, i, tag.name);
        if (end > i) {
          const text = s.slice(i, end);
          tokens.push({ type: 'text', text: ESCAPABLE_RAW_TEXT.has(tag.name) ? decodeReferences(text, false) : text, rawOf: tag.name });
        }
        textFrom = i = end;
      }
      continue;
    }
    if (next === SLASH) {
      const after = s.charCodeAt(lt + 2);
      if (Number.isNaN(after)) break; // `</` at the end is text
      pushText(lt);
      if (isAsciiAlpha(after)) {
        const tag = readTag(s, lt + 2);
        if (tag === null) {
          textFrom = n;
          break;
        }
        tokens.push({ type: 'end', name: tag.name });
        textFrom = i = tag.end;
      } else {
        // `</>` is nothing; `</` + anything else opens a bogus comment.
        textFrom = i = after === GT ? lt + 3 : bogusCommentEnd(s, lt + 2);
        if (after !== GT) tokens.push({ type: 'comment' });
      }
      continue;
    }
    if (next === BANG || next === QUESTION) {
      pushText(lt);
      textFrom = i = s.startsWith('<!--', lt) ? commentEnd(s, lt + 4) : bogusCommentEnd(s, lt + 2);
      tokens.push({ type: 'comment' });
      continue;
    }
    // A `<` that starts no markup is text.
    i = lt + 1;
  }
  pushText(n);
  return tokens;
}
