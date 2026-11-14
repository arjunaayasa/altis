// WinAnsiEncoding (PDF 1.4 Appendix D, the 1252 code page) for the standard Type 1 fonts, which are not embedded
// (Phase 2 spec §7, D2-16). A character WinAnsi has keeps its byte. An invisible format character (a zero-width space
// or joiner, a direction mark, a byte order mark) prints as nothing. The modifier letters of romanised Arabic and
// Hebrew (`ʾ`, `ʿ`, `ʼ`, `ʻ`) print as the quotation mark they look like. Any other character is transliterated: NFKD,
// combining marks stripped. What is still outside WinAnsi becomes `?`. Pure; no I/O.

/** The characters of bytes 0x80-0x9F (code page 1252); the five bytes WinAnsi leaves undefined are absent. */
const HIGH_CONTROLS: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

const QUESTION_MARK = 0x3f;

/** The modifier letters of romanisation and the WinAnsi quotation mark each prints as (’ 0x92, ‘ 0x91). */
const MODIFIER_STAND_INS: Readonly<Record<number, number>> = {
  0x02b9: 0x92, // modifier letter prime
  0x02bc: 0x92, // modifier letter apostrophe
  0x02be: 0x92, // modifier letter right half ring (hamza)
  0x02bb: 0x91, // modifier letter turned comma
  0x02bd: 0x91, // modifier letter reversed comma
  0x02bf: 0x91, // modifier letter left half ring (ain)
};

/** Combining marks, stripped after NFKD. */
const MARKS_RE = /\p{M}/gu;
/** An invisible format character (zero-width space and joiners, direction marks, byte order mark, ...). */
const FORMAT_RE = /^\p{Cf}$/u;
/** A letter, mark or digit, the parts of a written text. */
const SCRIPT_TEXT_RE = /^[\p{L}\p{M}\p{N}]$/u;
/** The scripts of Latin text: Latin itself, and the characters shared by every script. */
const LATIN_OR_SHARED_RE = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]$/u;

/** True for a character of a writing system other than Latin (Arabic, Javanese, Han, Greek, ...). */
function otherScript(ch: string): boolean {
  return SCRIPT_TEXT_RE.test(ch) && !LATIN_OR_SHARED_RE.test(ch);
}

/** The WinAnsi byte of a code point, or -1 (controls, DEL, C1 and everything WinAnsi lacks). */
function winAnsiByte(cp: number): number {
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return HIGH_CONTROLS[cp] ?? -1;
}

/**
 * `s` in WinAnsi. The text is composed (NFC) first, so an `e` followed by a combining acute keeps the byte of e-acute.
 * A format character outside WinAnsi is dropped (it is invisible), and a modifier letter of romanisation prints as its
 * quotation mark. Any other character outside WinAnsi is decomposed (NFKD) and its combining marks are stripped: E
 * with macron becomes `E`, the fi ligature `fi`. A character still outside WinAnsi becomes one `?` (a control
 * character, a lone surrogate, an emoji, another script); `replaced` counts them, and `otherScript` those of them that
 * are letters or digits of a writing system other than Latin (the text the PDF cannot show, as opposed to a symbol).
 */
export function toWinAnsi(s: string): { bytes: Uint8Array; replaced: number; otherScript: number } {
  const out: number[] = [];
  let replaced = 0;
  let other = 0;
  for (const ch of s.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    const direct = winAnsiByte(cp);
    if (direct >= 0) {
      out.push(direct);
      continue;
    }
    const standIn = MODIFIER_STAND_INS[cp];
    if (standIn !== undefined) {
      out.push(standIn);
      continue;
    }
    if (FORMAT_RE.test(ch)) continue;
    for (const part of ch.normalize('NFKD').replace(MARKS_RE, '')) {
      const b = winAnsiByte(part.codePointAt(0)!);
      if (b >= 0) out.push(b);
      else {
        out.push(QUESTION_MARK);
        replaced++;
        if (otherScript(ch)) other++;
      }
    }
  }
  return { bytes: Uint8Array.from(out), replaced, otherScript: other };
}
