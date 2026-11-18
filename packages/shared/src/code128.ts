// Code 128 (ISO/IEC 15417) for item barcodes on labels and member numbers on cards (Phase 2 spec §7: the default
// symbology), shared so that the server's print code and the admin's card preview draw the same bars. Every barcode
// character is printable ASCII (0x20-0x7E, spec §3.4), which set B holds. Runs of digits go into set C (two digits per
// symbol) wherever that makes the symbol shorter. Pure; no I/O.

/** Symbol values 0-106 as element widths (bar, space, bar, space, bar, space; the stop has a final bar). */
const PATTERNS: readonly string[] = [
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
];

const CODE_C = 99;
const CODE_B = 100;
const START_B = 104;
const START_C = 105;
const STOP = 106;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/**
 * The data symbols of `codes` (printable ASCII), using the fewest symbols over sets B and C. `costB[i]`/`costC[i]`
 * are the fewest symbols that encode `codes[i..]` when the symbol before is in set B/C; on a tie, the current set is
 * kept, so the result switches as rarely as possible.
 */
function dataSymbols(codes: readonly number[]): { start: number; symbols: number[] } {
  const n = codes.length;
  const pairAt = (i: number): boolean => i + 1 < n && isDigit(codes[i]!) && isDigit(codes[i + 1]!);
  const costB = new Array<number>(n + 1).fill(0);
  const costC = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const pair = pairAt(i);
    costB[i] = Math.min(1 + costB[i + 1]!, pair ? 2 + costC[i + 2]! : Infinity);
    costC[i] = Math.min(pair ? 1 + costC[i + 2]! : Infinity, 2 + costB[i + 1]!);
  }
  let set: 'B' | 'C' = costC[0]! < costB[0]! ? 'C' : 'B';
  const start = set === 'C' ? START_C : START_B;
  const symbols: number[] = [];
  let i = 0;
  while (i < n) {
    const pair = pairAt(i);
    if (set === 'B') {
      if (1 + costB[i + 1]! <= (pair ? 2 + costC[i + 2]! : Infinity)) {
        symbols.push(codes[i]! - 0x20);
        i += 1;
      } else {
        symbols.push(CODE_C);
        set = 'C';
      }
    } else if (pair && 1 + costC[i + 2]! <= 2 + costB[i + 1]!) {
      symbols.push((codes[i]! - 0x30) * 10 + (codes[i + 1]! - 0x30));
      i += 2;
    } else {
      symbols.push(CODE_B);
      set = 'B';
    }
  }
  return { start, symbols };
}

/**
 * The modules of `data` as Code 128 (true = a dark module): the start, the data, the check symbol (start value + the
 * sum of position × value, mod 103) and the stop. The quiet zones (10 modules each side) are not included. An empty
 * value or a character outside 0x20-0x7E is a TypeError.
 */
export function code128Modules(data: string): boolean[] {
  if (data.length === 0) throw new TypeError('code128: empty value');
  const codes: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new TypeError(`code128: character ${c} at ${i} is outside 0x20-0x7E`);
    codes.push(c);
  }
  const { start, symbols } = dataSymbols(codes);
  let check = start;
  symbols.forEach((v, k) => {
    check += v * (k + 1);
  });
  const modules: boolean[] = [];
  for (const value of [start, ...symbols, check % 103, STOP]) {
    const widths = PATTERNS[value]!;
    for (let e = 0; e < widths.length; e++) {
      const dark = e % 2 === 0;
      for (let m = Number(widths[e]); m > 0; m--) modules.push(dark);
    }
  }
  return modules;
}
