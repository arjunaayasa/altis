// Code 39 (ISO/IEC 16388) for item barcodes on labels (Phase 2 spec §7: the alternative symbology, for older
// scanners). It holds `A-Z 0-9 - . space $ / + %` and is framed by `*`; no check character is added. A wide element
// is three modules and a narrow one one module (ratio 3:1), with a one-module gap between characters. Pure; no I/O.

/** The nine elements (bar, space, ..., bar) of each character, 1 = wide. */
const ELEMENTS: Readonly<Record<string, string>> = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001',
  '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
  A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000', F: '001011000',
  G: '000001101', H: '100001100', I: '001001100', J: '000011100', K: '100000011', L: '001000011',
  M: '101000010', N: '000010011', O: '100010010', P: '001010010', Q: '000000111', R: '100000110',
  S: '001000110', T: '000010110', U: '110000001', V: '011000001', W: '111000000', X: '010010001',
  Y: '110010000', Z: '011010000', '-': '010000101', '.': '110000100', ' ': '011000100', $: '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100',
};

const WIDE = 3;
const FRAME = '*';

/**
 * The modules of `data` as Code 39 (true = a dark module), framed by `*`, without the quiet zones (10 modules each
 * side). ASCII lower-case letters are upper-cased. An empty value, `*` or any other character is a TypeError.
 */
export function code39Modules(data: string): boolean[] {
  if (data.length === 0) throw new TypeError('code39: empty value');
  const upper = data.replace(/[a-z]/g, (c) => c.toUpperCase());
  for (let i = 0; i < upper.length; i++) {
    const c = upper[i]!;
    if (c === FRAME || !Object.hasOwn(ELEMENTS, c)) {
      throw new TypeError(`code39: character ${upper.charCodeAt(i)} at ${i} is not in its set`);
    }
  }
  const modules: boolean[] = [];
  for (const c of FRAME + upper + FRAME) {
    if (modules.length > 0) modules.push(false);
    const elements = ELEMENTS[c]!;
    for (let e = 0; e < 9; e++) {
      const dark = e % 2 === 0;
      for (let m = elements[e] === '1' ? WIDE : 1; m > 0; m--) modules.push(dark);
    }
  }
  return modules;
}
