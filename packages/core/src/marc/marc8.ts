// MARC-8 → Unicode (Phase 2 spec §5.1, decision D2-12): only Basic Latin (ASCII, the default G0) and Extended Latin
// (ANSEL, the default G1) are read. An escape sequence that designates any other MARC-8 set (Greek symbols,
// subscripts, superscripts, Hebrew, Cyrillic, Arabic, Greek, East Asian) makes each character read in that set a `?`,
// counted in `replaced`. A combining mark comes before its base character in MARC-8 and after it in Unicode; the text
// is returned in NFC. Pure; no I/O.

/** ANSEL (Extended Latin) spacing characters, by byte. */
const ANSEL_SPACING: ReadonlyMap<number, string> = new Map([
  [0xa1, '\u{0141}'], // Ł
  [0xa2, '\u{00D8}'], // Ø
  [0xa3, '\u{0110}'], // Đ
  [0xa4, '\u{00DE}'], // Þ
  [0xa5, '\u{00C6}'], // Æ
  [0xa6, '\u{0152}'], // Œ
  [0xa7, '\u{02B9}'], // ʹ (soft sign, prime)
  [0xa8, '\u{00B7}'], // · (middle dot)
  [0xa9, '\u{266D}'], // ♭ (musical flat)
  [0xaa, '\u{00AE}'], // ®
  [0xab, '\u{00B1}'], // ±
  [0xac, '\u{01A0}'], // Ơ
  [0xad, '\u{01AF}'], // Ư
  [0xae, '\u{02BC}'], // ʼ (alif)
  [0xb0, '\u{02BB}'], // ʻ (ayn)
  [0xb1, '\u{0142}'], // ł
  [0xb2, '\u{00F8}'], // ø
  [0xb3, '\u{0111}'], // đ
  [0xb4, '\u{00FE}'], // þ
  [0xb5, '\u{00E6}'], // æ
  [0xb6, '\u{0153}'], // œ
  [0xb7, '\u{02BA}'], // ʺ (hard sign, double prime)
  [0xb8, '\u{0131}'], // ı (dotless i)
  [0xb9, '\u{00A3}'], // £
  [0xba, '\u{00F0}'], // ð
  [0xbc, '\u{01A1}'], // ơ
  [0xbd, '\u{01B0}'], // ư
  [0xc0, '\u{00B0}'], // °
  [0xc1, '\u{2113}'], // ℓ (script small l)
  [0xc2, '\u{2117}'], // ℗
  [0xc3, '\u{00A9}'], // ©
  [0xc4, '\u{266F}'], // ♯ (musical sharp)
  [0xc5, '\u{00BF}'], // ¿
  [0xc6, '\u{00A1}'], // ¡
  [0xc7, '\u{00DF}'], // ß
  [0xc8, '\u{20AC}'], // €
]);

/** ANSEL combining (nonspacing) marks, by byte: written before their base in MARC-8. */
const ANSEL_COMBINING: ReadonlyMap<number, string> = new Map([
  [0xe0, '\u{0309}'], // hook above (pseudo question mark)
  [0xe1, '\u{0300}'], // grave
  [0xe2, '\u{0301}'], // acute
  [0xe3, '\u{0302}'], // circumflex
  [0xe4, '\u{0303}'], // tilde
  [0xe5, '\u{0304}'], // macron
  [0xe6, '\u{0306}'], // breve
  [0xe7, '\u{0307}'], // dot above (superior dot)
  [0xe8, '\u{0308}'], // diaeresis (umlaut)
  [0xe9, '\u{030C}'], // caron (hacek)
  [0xea, '\u{030A}'], // ring above (circle above, angstrom)
  [0xeb, '\u{FE20}'], // ligature, first half
  [0xec, '\u{FE21}'], // ligature, second half
  [0xed, '\u{0315}'], // comma above right (high comma, off centre)
  [0xee, '\u{030B}'], // double acute
  [0xef, '\u{0310}'], // candrabindu
  [0xf0, '\u{0327}'], // cedilla
  [0xf1, '\u{0328}'], // ogonek (right hook)
  [0xf2, '\u{0323}'], // dot below
  [0xf3, '\u{0324}'], // diaeresis below (double dot below)
  [0xf4, '\u{0325}'], // ring below (circle below)
  [0xf5, '\u{0333}'], // double low line (double underscore)
  [0xf6, '\u{0332}'], // low line (underscore)
  [0xf7, '\u{0326}'], // comma below (left hook)
  [0xf8, '\u{031C}'], // left half ring below (right cedilla)
  [0xf9, '\u{032E}'], // breve below (half circle below)
  [0xfa, '\u{FE22}'], // double tilde, first half
  [0xfb, '\u{FE23}'], // double tilde, second half
  [0xfe, '\u{0313}'], // comma above (high comma, centred)
]);

const ESC = 0x1b;

/** What a graphic set (G0 or G1) currently holds: ASCII, ANSEL, or another set of 1 or 3 bytes per character. */
type GraphicSet = 'ascii' | 'ansel' | 'other1' | 'other3';

/**
 * A MARC-8 decoder that keeps its character sets across calls, for the subfields of one field (an escape holds until
 * the end of the field). `decode` flushes marks still waiting for a base at the end of each call.
 */
export interface Marc8Decoder {
  decode(bytes: Uint8Array): string;
  /** How many characters became `?` so far. */
  readonly replaced: number;
}

/** A decoder in the default state: G0 = ASCII, G1 = ANSEL. */
export function createMarc8Decoder(): Marc8Decoder {
  let g0: GraphicSet = 'ascii';
  let g1: GraphicSet = 'ansel';
  let replaced = 0;

  /** The set an escape's final character designates (`!E` is ANSEL, `B` ASCII; anything else is another set). */
  function designated(bytes: Uint8Array, i: number, multibyte: boolean): { set: GraphicSet; next: number } | null {
    const f = bytes[i];
    if (f === undefined) return null;
    if (f === 0x21) {
      const g = bytes[i + 1];
      if (g === undefined) return null;
      return { set: g === 0x45 && !multibyte ? 'ansel' : multibyte ? 'other3' : 'other1', next: i + 2 };
    }
    if (f < 0x20 || f > 0x7e) return null;
    if (multibyte) return { set: 'other3', next: i + 1 };
    return { set: f === 0x42 ? 'ascii' : 'other1', next: i + 1 };
  }

  /** Applies the escape sequence at `i` (just after ESC); returns the index after it, or -1 when it is malformed. */
  function escape(bytes: Uint8Array, i: number): number {
    const c = bytes[i];
    if (c === undefined) return -1;
    // Technique 1: Greek symbols (g), subscripts (b), superscripts (p) in G0; `s` returns G0 to ASCII.
    if (c === 0x73) {
      g0 = 'ascii';
      return i + 1;
    }
    if (c === 0x67 || c === 0x62 || c === 0x70) {
      g0 = 'other1';
      return i + 1;
    }
    // Technique 2 (ISO 2022): `(` `,` designate G0, `)` `-` designate G1; `$` announces a multibyte set.
    let multibyte = false;
    let at = i;
    if (c === 0x24) {
      multibyte = true;
      at++;
    }
    const intermediate = bytes[at];
    if (intermediate === undefined) return -1;
    let target: 'g0' | 'g1' = 'g0';
    if (intermediate === 0x28 || intermediate === 0x2c) at++;
    else if (intermediate === 0x29 || intermediate === 0x2d) {
      target = 'g1';
      at++;
    } else if (!multibyte) return -1; // `ESC $ F` designates G0 directly
    const d = designated(bytes, at, multibyte);
    if (d === null) return -1;
    if (target === 'g0') g0 = d.set;
    else g1 = d.set;
    return d.next;
  }

  return {
    get replaced() {
      return replaced;
    },
    decode(bytes: Uint8Array): string {
      let out = '';
      /** Combining marks read since the last base character. */
      let marks = '';
      const base = (ch: string) => {
        out += ch + marks;
        marks = '';
      };
      const unknown = () => {
        replaced++;
        base('?');
      };
      let i = 0;
      while (i < bytes.length) {
        const b = bytes[i]!;
        if (b === ESC) {
          const next = escape(bytes, i + 1);
          if (next < 0) {
            unknown();
            i++;
          } else i = next;
          continue;
        }
        if (b === 0x20) {
          base(' ');
          i++;
          continue;
        }
        // Graphic characters: 0x21-0x7E are read through G0, 0xA1-0xFE through G1.
        const inG0 = b >= 0x21 && b <= 0x7e;
        const inG1 = b >= 0xa1 && b <= 0xfe;
        if (inG0 || inG1) {
          const set = inG0 ? g0 : g1;
          if (set === 'other1' || set === 'other3') {
            unknown();
            i += set === 'other3' ? 3 : 1;
            continue;
          }
          if (set === 'ascii') base(String.fromCharCode(b & 0x7f));
          else {
            const byte = b | 0x80;
            const mark = ANSEL_COMBINING.get(byte);
            if (mark !== undefined) marks += mark;
            else {
              const ch = ANSEL_SPACING.get(byte);
              if (ch !== undefined) base(ch);
              else unknown();
            }
          }
          i++;
          continue;
        }
        // C1 controls of MARC-8: the nonsort markers carry no character; the joiners map to Unicode.
        if (b === 0x88 || b === 0x89) {
          i++;
          continue;
        }
        if (b === 0x8d) base('\u{200D}');
        else if (b === 0x8e) base('\u{200C}');
        else if (b >= 0x80) unknown();
        else base(String.fromCharCode(b)); // C0 controls and DEL as they are
        i++;
      }
      // Marks with no base left (a broken field) stay, after what came before them.
      out += marks;
      return out.normalize('NFC');
    },
  };
}

/** MARC-8 bytes (ASCII + ANSEL) → Unicode NFC text; characters of any other set become `?` and are counted. */
export function decodeMarc8(bytes: Uint8Array): { text: string; replaced: number } {
  const decoder = createMarc8Decoder();
  const text = decoder.decode(bytes);
  return { text, replaced: decoder.replaced };
}
