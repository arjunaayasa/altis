// Test-only barcode readers (Phase 2 Task 7, acceptance K13). They read a module pattern back to its text, so a test
// can check what src/print draws without trusting the encoder. A pattern is a list of modules (true = dark) without
// the quiet zones. The tables are typed here on their own from the published symbology specifications (ISO/IEC 15417
// Code 128, ISO/IEC 16388 Code 39). barcodes.test.ts pins their structural properties: distinct patterns, module
// sums, bar parity and the well-known start and stop strings.

/** Code 128 symbol values 0-106 as element widths (bar, space, bar, ...): 103-105 are the starts, 106 the stop. */
export const CODE128_WIDTHS: readonly string[] = Object.freeze([
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]);

/** Code 39 characters as their nine elements (bar, space, ..., bar), 1 = wide. `*` is the start/stop character. */
export const CODE39_ELEMENTS: Readonly<Record<string, string>> = Object.freeze({
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001',
  '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
  A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000', F: '001011000',
  G: '000001101', H: '100001100', I: '001001100', J: '000011100', K: '100000011', L: '001000011',
  M: '101000010', N: '000010011', O: '100010010', P: '001010010', Q: '000000111', R: '100000110',
  S: '001000110', T: '000010110', U: '110000001', V: '011000001', W: '111000000', X: '010010001',
  Y: '110010000', Z: '011010000', '-': '010000101', '.': '110000100', ' ': '011000100', $: '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100',
});

/** The run lengths of a module pattern, which must start and end with a dark module. */
export function moduleRuns(modules: readonly boolean[]): number[] {
  if (modules.length === 0 || modules[0] !== true || modules[modules.length - 1] !== true) {
    throw new Error('a barcode pattern starts and ends with a bar');
  }
  const runs: number[] = [];
  let run = 1;
  for (let i = 1; i < modules.length; i++) {
    if (modules[i] === modules[i - 1]) run++;
    else {
      runs.push(run);
      run = 1;
    }
  }
  runs.push(run);
  return runs;
}

/** A Code 128 reading: the text, the symbol values from the start to the last data symbol, and the check symbol. */
export interface Code128Reading {
  text: string;
  values: number[];
  checksum: number;
}

/**
 * Reads Code 128: a start (A, B or C), data symbols, the check symbol (start value + the sum of position × value, mod
 * 103) and the stop. Throws on an unknown pattern, a missing start or stop, a wrong check symbol or a function code.
 */
export function decodeCode128(modules: readonly boolean[]): Code128Reading {
  const runs = moduleRuns(modules);
  if (runs.length < 6 * 2 + 7 || (runs.length - 7) % 6 !== 0) throw new Error(`code128: ${runs.length} runs`);
  if (runs.slice(-7).join('') !== CODE128_WIDTHS[106]) throw new Error('code128: no stop pattern');
  const symbols: number[] = [];
  for (let i = 0; i < runs.length - 7; i += 6) {
    const value = CODE128_WIDTHS.indexOf(runs.slice(i, i + 6).join(''));
    if (value < 0 || value > 105) throw new Error(`code128: unknown symbol at run ${i}`);
    symbols.push(value);
  }
  const checksum = symbols.pop()!;
  const [start, ...data] = symbols;
  if (start === undefined || start < 103) throw new Error('code128: no start symbol');
  let sum = start;
  data.forEach((v, i) => {
    sum += v * (i + 1);
  });
  if (sum % 103 !== checksum) throw new Error(`code128: check symbol ${checksum}, expected ${sum % 103}`);
  let set: 'A' | 'B' | 'C' = start === 103 ? 'A' : start === 104 ? 'B' : 'C';
  let text = '';
  for (const v of data) {
    if (set === 'C') {
      if (v < 100) text += String(v).padStart(2, '0');
      else if (v === 100) set = 'B';
      else if (v === 101) set = 'A';
      else throw new Error(`code128: function code ${v} in set C`);
    } else if (v === 99) set = 'C';
    else if (v === 100 && set === 'A') set = 'B';
    else if (v === 101 && set === 'B') set = 'A';
    else if (v < 96) text += String.fromCharCode(set === 'B' || v < 64 ? v + 32 : v - 64);
    else throw new Error(`code128: function code ${v} in set ${set}`);
  }
  return { text, values: [start, ...data], checksum };
}

/**
 * Reads Code 39: characters of nine elements (three of them wide, a wide element 2-3 times a narrow one) separated by
 * one narrow gap and framed by `*`. Throws on an unknown character, a wide gap, a missing frame or a `*` inside.
 */
export function decodeCode39(modules: readonly boolean[]): string {
  const runs = moduleRuns(modules);
  if ((runs.length + 1) % 10 !== 0) throw new Error(`code39: ${runs.length} runs`);
  const narrow = Math.min(...runs);
  const wide = Math.max(...runs);
  if (wide < 2 * narrow || wide > 3 * narrow) throw new Error(`code39: wide/narrow ratio ${wide / narrow}`);
  const byElements = new Map(Object.entries(CODE39_ELEMENTS).map(([ch, el]) => [el, ch]));
  const chars: string[] = [];
  for (let i = 0; i < runs.length; i += 10) {
    const elements = runs.slice(i, i + 9).map((r) => {
      if (r === narrow) return '0';
      if (r === wide) return '1';
      throw new Error(`code39: element of ${r} modules`);
    });
    const ch = byElements.get(elements.join(''));
    if (ch === undefined) throw new Error(`code39: unknown character at run ${i}`);
    if (i + 9 < runs.length && runs[i + 9] !== narrow) throw new Error(`code39: wide gap after character ${chars.length}`);
    chars.push(ch);
  }
  if (chars.length < 2 || chars[0] !== '*' || chars[chars.length - 1] !== '*') throw new Error('code39: no * frame');
  const inner = chars.slice(1, -1);
  if (inner.includes('*')) throw new Error('code39: * inside the data');
  return inner.join('');
}

/**
 * The module pattern of bars drawn as filled rectangles in one row (x and width in any one unit). The narrowest bar is
 * one module; every bar and every gap must be a whole number of modules.
 */
export function barsToModules(bars: readonly { x: number; w: number }[]): boolean[] {
  if (bars.length === 0) throw new Error('no bars');
  const sorted = [...bars].sort((a, b) => a.x - b.x);
  const unit = Math.min(...sorted.map((b) => b.w));
  const count = (length: number, what: string): number => {
    const n = Math.round(length / unit);
    if (n < 1 || Math.abs(length / unit - n) > 0.02) throw new Error(`${what} of ${length / unit} modules`);
    return n;
  };
  const modules: boolean[] = [];
  sorted.forEach((bar, i) => {
    if (i > 0) {
      const prev = sorted[i - 1]!;
      modules.push(...Array<boolean>(count(bar.x - (prev.x + prev.w), 'gap')).fill(false));
    }
    modules.push(...Array<boolean>(count(bar.w, 'bar')).fill(true));
  });
  return modules;
}
