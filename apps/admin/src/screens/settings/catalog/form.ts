import {
  CatalogSettingsBody,
  LABEL_PAGE_MM,
  type BarcodePattern,
  type BarcodeSymbology,
  type CatalogSettings,
  type LabelPageName,
  type LabelProfile,
  type SruServer,
} from '@altis/shared/api/settings';
import type { FieldError, FieldErrors } from 'react-hook-form';
import { z } from 'zod';
import type { AdminKey, Translate } from '@/i18n';
import { fieldErrorText } from '@/lib/form-errors';

/**
 * The form model of Pengaturan › Katalog (Phase 2 plan Task 28): the values the form edits, how they become the
 * `catalog` group's settings (checked by the shared {@link CatalogSettingsBody}, the schema the server applies, so a
 * 21st pattern, a duplicate code or a sheet that does not fit is refused before anything is sent: D35, M1), the
 * `PUT settings/catalog` body (only the keys that changed; a list that changed is sent whole), and the helpers the
 * three list editors share (catalog/barcode-patterns.tsx, label-profiles.tsx, sru-servers.tsx).
 */

/** An entry of a list: `locked` once it was saved (its code is then read-only: other data refers to it). */
type Lockable<T> = T & { locked: boolean };

/** A barcode pattern as the form edits it. */
export type PatternValues = Lockable<BarcodePattern>;

/** The paper choices of a label profile: a named size, or `custom` with its own width and height. */
export type PageChoice = LabelPageName | 'custom';

/** A label profile as the form edits it: the page as a choice plus a size (a named size shows its own). */
export type ProfileValues = Lockable<Omit<LabelProfile, 'page'> & { page: { name: PageChoice; wMm: number; hMm: number } }>;

/** An SRU server as the form edits it. */
export type ServerValues = Lockable<SruServer>;

/** The values of the whole form. A text that may be null is `''` here; a master id `''` is "none". */
export interface CatalogFormValues {
  marcOrgCode: string;
  defaultMaterialTypeId: string;
  defaultCollectionTypeId: string;
  currency: string;
  barcode: { patterns: PatternValues[]; symbology: BarcodeSymbology };
  labelProfiles: ProfileValues[];
  sru: { servers: ServerValues[]; allowPrivateHosts: boolean };
  /** Reserved (ruling R23): carried as stored, never edited and never sent; the community edition ignores it. */
  isbn: { arsyaEnabled: boolean };
  attachment: { maxMb: number };
  dedupe: { threshold: number };
}

/** A stored profile as the form edits it: a named page carries its own size, shown read-only. */
function profileValues(p: LabelProfile): ProfileValues {
  const page =
    typeof p.page === 'string' ? { name: p.page, wMm: LABEL_PAGE_MM[p.page].w, hMm: LABEL_PAGE_MM[p.page].h } : { name: 'custom' as const, ...p.page };
  return { ...structuredClone(p), page, locked: true };
}

/** The form's values for the stored group. */
export function catalogFormValues(view: CatalogSettings): CatalogFormValues {
  return {
    marcOrgCode: view.marcOrgCode ?? '',
    defaultMaterialTypeId: view.defaultMaterialTypeId ?? '',
    defaultCollectionTypeId: view.defaultCollectionTypeId ?? '',
    currency: view.currency,
    barcode: { patterns: view.barcode.patterns.map((p) => ({ ...p, locked: true })), symbology: view.barcode.symbology },
    labelProfiles: view.labelProfiles.map(profileValues),
    sru: { servers: view.sru.servers.map((s) => ({ ...structuredClone(s), locked: true })), allowPrivateHosts: view.sru.allowPrivateHosts },
    isbn: { arsyaEnabled: view.isbn.arsyaEnabled },
    attachment: { maxMb: view.attachment.maxMb },
    dedupe: { threshold: view.dedupe.threshold },
  };
}

/** A label profile of the form as the settings hold it (the page back to its name or its size). */
export function profileOf(p: ProfileValues): LabelProfile {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    page: p.page.name === 'custom' ? { wMm: p.page.wMm, hMm: p.page.hMm } : p.page.name,
    marginMm: { t: p.marginMm.t, r: p.marginMm.r, b: p.marginMm.b, l: p.marginMm.l },
    cols: p.cols,
    rows: p.rows,
    labelWMm: p.labelWMm,
    labelHMm: p.labelHMm,
    gapXMm: p.gapXMm,
    gapYMm: p.gapYMm,
    fontPt: p.fontPt,
    header: p.header,
    showLibraryName: p.showLibraryName,
    symbology: p.symbology,
    titleMaxChars: p.titleMaxChars,
    border: p.border,
  };
}

/**
 * The form's values as the settings of the group, every key present (each entry picked field by field: the shared
 * schemas are strict). The strings the server would refuse for a blank stay as typed, except the two that mean
 * "none" when blank (the MARC code and the defaults) and the currency, written in capitals.
 */
export function settingsOf(v: CatalogFormValues): CatalogSettings {
  const code = v.marcOrgCode.trim();
  return {
    marcOrgCode: code === '' ? null : code,
    defaultMaterialTypeId: v.defaultMaterialTypeId === '' ? null : v.defaultMaterialTypeId,
    defaultCollectionTypeId: v.defaultCollectionTypeId === '' ? null : v.defaultCollectionTypeId,
    currency: v.currency.trim().toUpperCase(),
    barcode: {
      patterns: v.barcode.patterns.map((p) => ({ id: p.id, name: p.name, prefix: p.prefix, digits: p.digits, suffix: p.suffix })),
      symbology: v.barcode.symbology,
    },
    labelProfiles: v.labelProfiles.map(profileOf),
    sru: {
      servers: v.sru.servers.map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url.trim(),
        version: s.version,
        recordSchema: s.recordSchema,
        indexes: { isbn: s.indexes.isbn, title: s.indexes.title, author: s.indexes.author, any: s.indexes.any },
        enabled: s.enabled,
      })),
      allowPrivateHosts: v.sru.allowPrivateHosts,
    },
    isbn: { arsyaEnabled: v.isbn.arsyaEnabled },
    attachment: { maxMb: v.attachment.maxMb },
    dedupe: { threshold: v.dedupe.threshold },
  };
}

/**
 * The form's schema: the values as settings ({@link settingsOf}), checked by the shared strict body schema, whose
 * output (prefixes and suffixes in capitals, names trimmed) is the settings as they would be stored: the body held
 * every key, so its output does too. Issue paths are the body's, which are the form's (a profile's page aside: `page`
 * there is `{name, wMm, hMm}`, and a custom size that fails is reported on `page` itself).
 */
export const CatalogForm = z
  .custom<CatalogFormValues>((value) => typeof value === 'object' && value !== null)
  .transform((values): z.input<typeof CatalogSettingsBody> => settingsOf(values))
  .pipe(CatalogSettingsBody)
  .transform((checked) => checked as CatalogSettings);

/**
 * The messages of the shared schemas' own field-error codes (`duplicate`, `does_not_fit`, `required`). A schema's
 * issue carries its code as its message, so the form gets `{type: 'custom', message: code}`; a server's
 * VALIDATION_FAILED names the code as the type (`{type: code}`). {@link ownError} reads both.
 */
const OWN_MESSAGES: Readonly<Record<string, AdminKey>> = {
  duplicate: 'catalog.settings.error.duplicate',
  does_not_fit: 'catalog.settings.labels.does_not_fit',
  required: 'form.error.required',
};

const ownMessage = (code: string | undefined): AdminKey | undefined =>
  code !== undefined && Object.hasOwn(OWN_MESSAGES, code) ? OWN_MESSAGES[code] : undefined;

/** The error at the `.`-joined `path` of `errors` (a list's own error may sit on its `root`), or undefined. */
export function errorAt(errors: FieldErrors<CatalogFormValues>, path: string): FieldError | undefined {
  let node: unknown = errors;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'object' || node === null) return undefined;
  const own = node as Partial<FieldError> & { root?: FieldError };
  if (typeof own.type === 'string' || typeof own.message === 'string') return own as FieldError;
  return own.root;
}

/**
 * `error` with our own message for the shared schemas' own codes ({@link OWN_MESSAGES}), which the generic forms would
 * show as "Isian ini belum benar."; undefined for no error.
 */
export function ownError(error: FieldError | undefined): { type?: string; message?: string } | undefined {
  if (error === undefined) return undefined;
  const type = String(error.type);
  return { type, message: ownMessage(type) ?? ownMessage(error.message) ?? error.message };
}

/** The text of a field error (our own codes included), or undefined. */
export function errorText(t: Translate, error: FieldError | undefined): string | undefined {
  return fieldErrorText(t, ownError(error));
}

/**
 * The largest length a list schema allows (its `max_length` check): 20 patterns, 20 profiles, 10 servers. The editors
 * refuse an entry past it with the same limit the server applies (M1).
 */
export function listMax(schema: z.ZodArray): number {
  for (const check of schema.def.checks ?? []) {
    const def = check._zod.def as { check: string; maximum?: number };
    if (def.check === 'max_length' && typeof def.maximum === 'number') return def.maximum;
  }
  return Number.MAX_SAFE_INTEGER;
}

/** A code not in `taken`: `<stem>-<n>` from `n` up. */
export function freeCode(stem: string, n: number, taken: readonly string[]): string {
  let i = n;
  while (taken.includes(`${stem}-${i}`)) i += 1;
  return `${stem}-${i}`;
}

/** Deep equality of JSON-like values (key order ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const list = b as unknown[];
    return a.length === list.length && a.every((item, i) => sameValue(item, list[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Whether a setting `body` would write was changed by someone else since the form loaded `view`: `fresh` (read again
 * just before the PUT) holds another value there. The PUT replaces a list whole, so writing it then would silently undo
 * the other change (the settings API has no version to refuse it). Settings the body leaves alone do not count.
 */
export function changedElsewhere(body: CatalogSettingsBody, view: CatalogSettings, fresh: CatalogSettings): boolean {
  const stored = (s: CatalogSettings, key: string, sub?: string): unknown => {
    const value = (s as unknown as Record<string, unknown>)[key];
    return sub === undefined ? value : (value as Record<string, unknown> | undefined)?.[sub];
  };
  for (const [key, value] of Object.entries(body)) {
    const nested = value !== null && typeof value === 'object' && !Array.isArray(value);
    const subs = nested ? Object.keys(value as object) : [undefined];
    for (const sub of subs) if (!sameValue(stored(fresh, key, sub), stored(view, key, sub))) return true;
  }
  return false;
}

/**
 * The `PUT settings/catalog` body: only what differs from `view` (a list that changed is sent whole). The reserved
 * `isbn.arsyaEnabled` is never sent.
 */
export function catalogBody(next: CatalogSettings, view: CatalogSettings): CatalogSettingsBody {
  const body: CatalogSettingsBody = {};
  const differs = (a: unknown, b: unknown): boolean => !sameValue(a, b);
  if (differs(next.marcOrgCode, view.marcOrgCode)) body.marcOrgCode = next.marcOrgCode;
  if (differs(next.defaultMaterialTypeId, view.defaultMaterialTypeId)) body.defaultMaterialTypeId = next.defaultMaterialTypeId;
  if (differs(next.defaultCollectionTypeId, view.defaultCollectionTypeId)) body.defaultCollectionTypeId = next.defaultCollectionTypeId;
  if (differs(next.currency, view.currency)) body.currency = next.currency;
  const barcode: NonNullable<CatalogSettingsBody['barcode']> = {};
  if (differs(next.barcode.patterns, view.barcode.patterns)) barcode.patterns = next.barcode.patterns;
  if (differs(next.barcode.symbology, view.barcode.symbology)) barcode.symbology = next.barcode.symbology;
  if (Object.keys(barcode).length > 0) body.barcode = barcode;
  if (differs(next.labelProfiles, view.labelProfiles)) body.labelProfiles = next.labelProfiles;
  const sru: NonNullable<CatalogSettingsBody['sru']> = {};
  if (differs(next.sru.servers, view.sru.servers)) sru.servers = next.sru.servers;
  if (differs(next.sru.allowPrivateHosts, view.sru.allowPrivateHosts)) sru.allowPrivateHosts = next.sru.allowPrivateHosts;
  if (Object.keys(sru).length > 0) body.sru = sru;
  if (differs(next.attachment.maxMb, view.attachment.maxMb)) body.attachment = { maxMb: next.attachment.maxMb };
  if (differs(next.dedupe.threshold, view.dedupe.threshold)) body.dedupe = { threshold: next.dedupe.threshold };
  return body;
}
