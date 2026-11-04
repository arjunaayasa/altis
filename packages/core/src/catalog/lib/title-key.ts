// The title key (spec §2.1): the title (+ subtitle) after NFKD, diacritics stripped, lower case, punctuation stripped,
// spaces collapsed, the leading article dropped by the MARC nonfiling indicator when known, cut to 191 characters.
// Used to sort by title and to pre-screen duplicates (§3.3). Pure; no database.

/** `title_key` is a key191() column: MySQL varchar(191) in utf8mb4 counts code points, so the cut does too. */
const TITLE_KEY_MAX = 191;

/** MARC 245 ind2 counts 0-9 nonfiling characters. */
const NONFILING_MAX = 9;

/** Latin letters that NFKD does not decompose, folded the way their diacritic-free spelling is usually written. */
const LATIN_FOLD: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
  ŧ: 't',
};
const LATIN_FOLD_RE = /[ßæœøđðłþıħŧ]/g;

/** Apostrophes are removed, not turned into a space, so `Qur'an` stays one word. */
const APOSTROPHES_RE = /['`\u{2018}\u{2019}\u{2BC}]/gu;

/** Anything that is not a letter, a digit or a (spacing or enclosing) mark separates words. */
const SEPARATORS_RE = /[^\p{L}\p{N}\p{M}]+/gu;

/** Nonspacing marks: what NFKD splits off as diacritics. */
const NONSPACING_MARKS_RE = /\p{Mn}+/gu;

/**
 * The folding shared by titleKey and recordSlug (internal, not in the barrel): NFKD, nonspacing marks removed, lower
 * case, the Latin letters NFKD keeps whole folded, apostrophes removed, every other run of non-word characters
 * turned into one space, trimmed.
 */
export function foldForKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(NONSPACING_MARKS_RE, '')
    .toLowerCase()
    .replace(LATIN_FOLD_RE, (c) => LATIN_FOLD[c] ?? c)
    .replace(APOSTROPHES_RE, '')
    .replace(SEPARATORS_RE, ' ')
    .trim();
}

/** The title without its first `nonfiling` characters, when that count is a usable MARC indicator; else the title. */
function withoutNonfiling(title: string, nonfiling: number | undefined): string {
  if (nonfiling === undefined || !Number.isInteger(nonfiling) || nonfiling <= 0 || nonfiling > NONFILING_MAX) return title;
  const chars = Array.from(title.trimStart());
  if (nonfiling >= chars.length) return title;
  const rest = chars.slice(nonfiling).join('');
  // A count that swallows every word (bad data) is ignored rather than leaving an empty key.
  return foldForKey(rest) === '' ? title : rest;
}

/**
 * The `title_key` of a title and its subtitle (spec §2.1). `nonfiling` is the MARC 245 ind2 count of characters to
 * skip ("The " = 4); a count outside 1-9, not an integer, or as long as the title is ignored. At most 191 code points,
 * never ending in a space; '' when the title holds no letter or digit.
 */
export function titleKey(title: string, subtitle?: string | null, nonfiling?: number): string {
  const main = withoutNonfiling(title, nonfiling);
  const key = foldForKey(subtitle ? `${main} ${subtitle}` : main);
  if (key.length <= TITLE_KEY_MAX) return key;
  const chars = Array.from(key);
  return chars.length <= TITLE_KEY_MAX ? key : chars.slice(0, TITLE_KEY_MAX).join('').trimEnd();
}
