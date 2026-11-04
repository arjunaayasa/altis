// Personal names (spec §2.1): stored in the MARC inverted form when there is a family name (`Toer, Pramoedya
// Ananta`), a single name as is (`Soekarno`). The direct form is shown and indexed next to it (§4.2). Pure.

/** ISBD punctuation that may trail a heading (`Toer, Pramoedya Ananta,` before `$d`). A final `.` is kept (`J.`). */
function trailingPunctuation(ch: string | undefined): boolean {
  return ch === ',' || ch === ';' || ch === ':' || ch === '/' || ch === ' ';
}

/**
 * The direct form of an inverted personal name: the part before the first comma moves after the given name, later
 * comma-separated parts (`Jr.`) follow it. `'Toer, Pramoedya Ananta'` → `'Pramoedya Ananta Toer'`. A name without a
 * comma is returned trimmed; whitespace is collapsed and trailing ISBD punctuation dropped.
 */
export function uninvertName(name: string): string {
  let s = name.replace(/\s+/g, ' ').trim();
  let end = s.length;
  while (end > 0 && trailingPunctuation(s[end - 1])) end--;
  s = s.slice(0, end);
  const comma = s.indexOf(',');
  if (comma < 0) return s;
  const family = s.slice(0, comma).trim();
  const rest = s
    .slice(comma + 1)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (rest.length === 0) return family;
  if (family === '') return rest.join(' ');
  const [given, ...suffixes] = rest;
  return [given, family, ...suffixes].join(' ');
}
