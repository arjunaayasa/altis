/**
 * The Dewey Decimal Classification as the reports count it. A record's class comes from the first token of its
 * classification, or, when the classification is empty, from its call number (the first token that starts with a digit
 * or with `2X`, past letter-only tokens such as `R`, `REF`, `F` or `FIK`). Three leading digits `abc` give the main
 * class `a00` and the division `ab0`. `2X…` (any case) is the Indonesian expansion of the 200s for Islam: a class of its
 * own, never counted in 200. Anything else (an empty value included) is `NON`, "Lainnya", with its token kept so the
 * report can break it down.
 *
 * The labels of the main classes are the shared `vocab.ddc_main.<main>`; division rows are labelled by their numbers
 * only (`810–819`). No Node built-ins here: the browser bundles this module.
 */

/** A main class: the ten hundreds, the Islamic expansion `2X`, and `NON` for anything that is not DDC. */
export type DdcMain = '000' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '2X' | 'NON';

/** The main classes in print order. */
export const DDC_MAINS: readonly DdcMain[] = Object.freeze([
  '000',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  '2X',
  'NON',
] as const);

/** The class of one record. */
export interface DdcClass {
  main: DdcMain;
  /** The division `ab0` of a three-digit class; null for `2X` and `NON`. */
  division: string | null;
  /** The token the class was read from (`''` when there was none). */
  token: string;
}

const THREE_DIGITS = /^(\d)(\d)\d/;
const ISLAMIC = /^2x/i;
const LETTERS_ONLY = /^\p{L}+$/u;

/** The first token of a trimmed text, or `''`. */
function firstToken(text: string): string {
  return text.trim().split(/\s+/u)[0] ?? '';
}

/** The class token of a call number: its first token that starts with a digit or `2X`, past letter-only tokens. */
function callNumberToken(callNumber: string): string {
  for (const token of callNumber.trim().split(/\s+/u)) {
    if (/^\d/.test(token) || ISLAMIC.test(token)) return token;
    if (!LETTERS_ONLY.test(token)) return '';
  }
  return '';
}

/** The DDC class of a record from its classification, or from its call number when the classification is empty. */
export function ddcClassOf(classification: string | null, callNumberFallback: string | null): DdcClass {
  const own = classification === null ? '' : firstToken(classification);
  const token = own !== '' ? own : callNumberFallback === null ? '' : callNumberToken(callNumberFallback);
  if (ISLAMIC.test(token)) return { main: '2X', division: null, token };
  const digits = THREE_DIGITS.exec(token);
  if (digits !== null) return { main: `${digits[1]}00` as DdcMain, division: `${digits[1]}${digits[2]}0`, token };
  return { main: 'NON', division: null, token };
}

// ---- grouped classifications ---------------------------------------------------------------------------------------

/**
 * A row of a DDC breakdown: a main class (`'000'`…`'900'`, `'2X'`, `'NON'`), a division (`'810'`; the first division of
 * a class, which shares the class's own number, is written {@link ddcDivisionKey}`('800')` = `'800-809'` so it never
 * adds into the class row), or a non-DDC token `'NON:<token>'` (`'NON:'` for no token at all).
 */
export type DdcRowKey = string;

/** The row key of a division `ab0`: the division itself, or `a00-a09` for the first division of class `a`. */
export function ddcDivisionKey(division: string): DdcRowKey {
  return /^\d00$/.test(division) ? `${division}-${division.slice(0, 2)}9` : division;
}

/** What a row key stands for, or null for a key that is none of them. */
export function ddcRowKind(key: DdcRowKey): 'main' | 'division' | '2X' | 'NON' | 'NON_token' | null {
  if (/^\d00$/.test(key)) return 'main';
  if (/^\d[1-9]0$/.test(key) || /^(\d)00-\d09$/.test(key)) return 'division';
  if (key === '2X') return '2X';
  if (key === 'NON') return 'NON';
  if (key.startsWith('NON:')) return 'NON_token';
  return null;
}

/**
 * Folds grouped classifications into DDC rows: each group's value is added under its main class; with `divisions`, a
 * three-digit class is also added under its division ({@link ddcDivisionKey}); with `nonTokens`, a `NON` value is also
 * added under `NON:<token>`. Only keys that received a group appear (the caller fills absent classes with its own
 * zero); sort the keys with {@link compareDdcRowKeys}.
 */
export function foldByDdc<T>(
  groups: Iterable<{ classification: string | null; callNumber: string | null; value: T }>,
  add: (acc: T | undefined, v: T) => T,
  o: { divisions: boolean; nonTokens: boolean },
): Map<DdcRowKey, T> {
  const out = new Map<DdcRowKey, T>();
  const put = (key: DdcRowKey, value: T): void => {
    out.set(key, add(out.get(key), value));
  };
  for (const group of groups) {
    const c = ddcClassOf(group.classification, group.callNumber);
    put(c.main, group.value);
    if (o.divisions && c.division !== null) put(ddcDivisionKey(c.division), group.value);
    if (o.nonTokens && c.main === 'NON') put(`NON:${c.token}`, group.value);
  }
  return out;
}

/** [main rank, place under the main, the rest] of a key; unknown keys sort last, by their text. */
function rankOf(key: DdcRowKey): [number, number, string] {
  const kind = ddcRowKind(key);
  switch (kind) {
    case 'main':
      return [Number(key[0]), 0, ''];
    case 'division':
      return [Number(key[0]), 1 + Number(key[1]), ''];
    case '2X':
      return [10, 0, ''];
    case 'NON':
      return [11, 0, ''];
    case 'NON_token':
      return [11, 1, key.slice('NON:'.length)];
    default:
      return [12, 0, key];
  }
}

/**
 * The print order of DDC row keys: the main classes in {@link DDC_MAINS} order, each followed by its divisions in
 * number order, and `NON` followed by its `NON:<token>` rows by token.
 */
export function compareDdcRowKeys(a: DdcRowKey, b: DdcRowKey): number {
  const [ma, sa, ta] = rankOf(a);
  const [mb, sb, tb] = rankOf(b);
  if (ma !== mb) return ma - mb;
  if (sa !== sb) return sa - sb;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}
