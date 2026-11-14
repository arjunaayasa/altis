// The names inside an evidence ZIP (spec §10.9): one folder per component (`K-koleksi/` … `G-pengelolaan/`), the
// profile's `profil/`, the statistics mode's `lampiran/`; the evidence file as `00-berkas-bukti.pdf`, a component's
// indicator sheets as `00-lembar-<folder>.pdf`, a per-component ZIP as `<folder>.zip`, and every evidence entry as
// `<official number>-<nn>-<slug>.<ext>`: the indicator's printed number, a two-digit counter per indicator, and an
// ASCII slug of the file's caption (or of the evidence item's label) of at most 60 characters.

/** The folders of an evidence ZIP. */
export const ZIP_FOLDERS = Object.freeze({
  K: 'K-koleksi',
  SP: 'SP-sarana',
  L: 'L-pelayanan',
  T: 'T-tenaga',
  F: 'F-penyelenggaraan',
  G: 'G-pengelolaan',
  profil: 'profil',
  lampiran: 'lampiran',
} as const);

export type ZipFolderCode = keyof typeof ZIP_FOLDERS;

/** The evidence file inside a ZIP. */
export const DOSSIER_ENTRY = '00-berkas-bukti.pdf';

/** The longest slug. */
export const SLUG_MAX = 60;

/** The indicator sheets of one component (`00-lembar-K-koleksi.pdf`). */
export function sheetEntryName(code: ZipFolderCode): string {
  return `00-lembar-${ZIP_FOLDERS[code]}.pdf`;
}

/** The ZIP of one component inside the outer ZIP (`K-koleksi.zip`). */
export function componentZipName(code: ZipFolderCode): string {
  return `${ZIP_FOLDERS[code]}.zip`;
}

/**
 * An ASCII slug of `text`: letters without their marks, lower case, every other run of characters one `-`, at most
 * {@link SLUG_MAX} characters cut at a word boundary when one is near; `berkas` when nothing is left.
 */
export function slugOf(text: string): string {
  const ascii = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii === '') return 'berkas';
  if (ascii.length <= SLUG_MAX) return ascii;
  const cut = ascii.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  const slug = lastDash >= SLUG_MAX / 2 ? cut.slice(0, lastDash) : cut;
  return slug.replace(/-+$/g, '');
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
});

/** The extension of a stored file: its original name's (1–8 letters or digits, lower case), else by its type, else `bin`. */
export function extensionOf(originalName: string, mime: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(originalName);
  if (m !== null) return m[1]!.toLowerCase();
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? 'bin';
}

/** The two-digit counter of an entry within its indicator (`01`; 100 and more as they are). */
export function counterText(n: number): string {
  return String(n).padStart(2, '0');
}

/** An evidence entry: `<folder>/<officialNo>-<nn>-<slug>.<ext>` (a prefix of `profil`, `prasyarat` … for the profile). */
export function evidenceEntryName(folder: ZipFolderCode, prefix: string, n: number, slug: string, ext: string): string {
  return `${ZIP_FOLDERS[folder]}/${prefix}-${counterText(n)}-${slug}.${ext}`;
}

/** An annex list of the statistics mode: `lampiran/<nn>-<slug>.pdf`. */
export function annexEntryName(n: number, slug: string): string {
  return `${ZIP_FOLDERS.lampiran}/${counterText(n)}-${slug}.pdf`;
}
