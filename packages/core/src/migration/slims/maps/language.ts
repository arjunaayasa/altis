// SLiMS languages (`mst_language`, `biblio.language_id`) as ALTIS languages (Phase 2 spec §11.4; plan Task 37). SLiMS
// keys a language by a short code it seeds as ISO 639-1 (`id`, `en`); ALTIS keys languages by their MARC code (≈ ISO
// 639-2/B, `ind`, `eng`). This is the built-in table between the two: ISO 639-1 codes of the languages an Indonesian
// library is likely to hold, with their Indonesian and English names. A code of three letters is taken as a MARC code
// already. Anything else is a language the table does not know: the stage makes a new language of it and reports it.
// Clean-room: from the ISO 639 code lists, not from SLiMS.

/** A language of the table: its MARC code and names (null: the table does not name it, the SLiMS name is used). */
export interface MarcLanguage {
  code: string;
  nameId: string | null;
  nameEn: string | null;
}

/** ISO 639-1 → [MARC code, Indonesian name, English name]. */
const ISO_639_1: Readonly<Record<string, readonly [string, string, string]>> = Object.freeze({
  id: ['ind', 'Indonesia', 'Indonesian'],
  in: ['ind', 'Indonesia', 'Indonesian'],
  en: ['eng', 'Inggris', 'English'],
  ar: ['ara', 'Arab', 'Arabic'],
  jv: ['jav', 'Jawa', 'Javanese'],
  jw: ['jav', 'Jawa', 'Javanese'],
  su: ['sun', 'Sunda', 'Sundanese'],
  ms: ['may', 'Melayu', 'Malay'],
  zh: ['chi', 'Tionghoa', 'Chinese'],
  ja: ['jpn', 'Jepang', 'Japanese'],
  ko: ['kor', 'Korea', 'Korean'],
  nl: ['dut', 'Belanda', 'Dutch'],
  de: ['ger', 'Jerman', 'German'],
  fr: ['fre', 'Prancis', 'French'],
  es: ['spa', 'Spanyol', 'Spanish'],
  pt: ['por', 'Portugis', 'Portuguese'],
  it: ['ita', 'Italia', 'Italian'],
  ru: ['rus', 'Rusia', 'Russian'],
  hi: ['hin', 'Hindi', 'Hindi'],
  th: ['tha', 'Thai', 'Thai'],
  vi: ['vie', 'Vietnam', 'Vietnamese'],
  tl: ['tgl', 'Tagalog', 'Tagalog'],
  la: ['lat', 'Latin', 'Latin'],
  el: ['gre', 'Yunani', 'Greek'],
  he: ['heb', 'Ibrani', 'Hebrew'],
  fa: ['per', 'Persia', 'Persian'],
  ur: ['urd', 'Urdu', 'Urdu'],
  bn: ['ben', 'Bengali', 'Bengali'],
  ta: ['tam', 'Tamil', 'Tamil'],
  tr: ['tur', 'Turki', 'Turkish'],
  pl: ['pol', 'Polandia', 'Polish'],
  sv: ['swe', 'Swedia', 'Swedish'],
  no: ['nor', 'Norwegia', 'Norwegian'],
  da: ['dan', 'Denmark', 'Danish'],
  fi: ['fin', 'Finlandia', 'Finnish'],
  cs: ['cze', 'Ceko', 'Czech'],
  hu: ['hun', 'Hungaria', 'Hungarian'],
  ro: ['rum', 'Rumania', 'Romanian'],
  uk: ['ukr', 'Ukraina', 'Ukrainian'],
  sa: ['san', 'Sanskerta', 'Sanskrit'],
  mi: ['mao', 'Maori', 'Maori'],
});

/**
 * The MARC language a SLiMS language code stands for (`id` → `ind`, `en_US` → `eng`, `IND` → `ind`), or null when the
 * table does not know it. Only the part before `_` or `-` counts, in any case.
 */
export function marcLanguage(slimsCode: string): MarcLanguage | null {
  const base = slimsCode.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  const known = Object.hasOwn(ISO_639_1, base) ? ISO_639_1[base] : undefined;
  if (known !== undefined) return { code: known[0], nameId: known[1], nameEn: known[2] };
  for (const [code, nameId, nameEn] of Object.values(ISO_639_1)) if (code === base) return { code, nameId, nameEn };
  return /^[a-z]{3}$/.test(base) ? { code: base, nameId: null, nameEn: null } : null;
}
