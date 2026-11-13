/**
 * Message catalogs shared by the server and the admin SPA (spec §3, decision D29): Indonesian first, English complete.
 *
 * - `id.ts` is the source of truth: {@link MessageKey} is its key set, and `en.ts` is typed `Record<MessageKey, string>`.
 * - Key families: `error.<CODE>`, `perm.<permission>`, `audit.<action>`, `role.<key>`, `mail.*`, `opac.*`, `banner.*`,
 *   and since 1c `ops.*`, `notification.*`, `alert.*`, `maintenance.*`; the vocabularies `vocab.<list>.<value>`; and for
 *   reports and accreditation `report.*` and `accred.*` (the later report owners' row labels come from i18n/k1/*.ts).
 *   A new error code, permission, audit action, op kind (`ops.kind.<kind>`) or op state (`ops.state.<state>`) without its
 *   message fails `tsc` (see `id.ts`) and the unit test.
 * - The SPA's own screen strings live in `apps/admin/src/i18n/`; its `useT()` falls back to {@link t} for the shared
 *   families.
 *
 * No Node built-ins here: the browser bundles this package.
 */
import { EN_MESSAGES } from './en.js';
import { ID_MESSAGES } from './id.js';
import type { MessageKey } from './id.js';

export type { MessageKey } from './id.js';

/** The UI languages, in display order. */
export const LOCALES = Object.freeze(['id', 'en'] as const);

export type Locale = (typeof LOCALES)[number];

/** Indonesian is the default UI language (§3). */
export const DEFAULT_LOCALE: Locale = 'id';

/** Every message of every locale. Frozen; the test profile's two extra keys exist only under `__BUILD_PROFILE__ === 'test'`. */
export const MESSAGES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = Object.freeze({
  id: ID_MESSAGES,
  en: EN_MESSAGES,
});

/** True when `s` is one of {@link LOCALES}; an exact match, so `EN` and `en-US` are not. */
export function isLocale(s: string): s is Locale {
  return (LOCALES as readonly string[]).includes(s);
}

/**
 * The first candidate that is a locale, else {@link DEFAULT_LOCALE}: the order of precedence is the caller's
 * (for the OPAC `?lang=`, then the library's language; for the SPA the user's, then the library's).
 */
export function resolveLocale(...candidates: (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isLocale(candidate)) return candidate;
  }
  return DEFAULT_LOCALE;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/**
 * `template` with every `{name}` replaced by `params[name]`, in one pass: a value that looks like a placeholder is not
 * expanded again, and the value is taken literally (no `$&`-style replacement patterns). Only an own property of
 * `params` fills a placeholder: `{constructor}` or `{toString}` stays as written unless `params` itself has it. A
 * placeholder with no value is left as written.
 */
export function fillPlaceholders(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(PLACEHOLDER, (whole: string, name: string) => {
    if (!hasOwn(params, name)) return whole;
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * The text of `key` in `locale`, with every `{name}` replaced by `params[name]` ({@link fillPlaceholders}). The
 * function never throws: an unknown locale answers in {@link DEFAULT_LOCALE}, a key missing at run time (the
 * test-profile keys in a production bundle) answers with the key itself.
 */
export function t(locale: Locale, key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const table = hasOwn(MESSAGES, locale) ? MESSAGES[locale] : MESSAGES[DEFAULT_LOCALE];
  const template = hasOwn(table, key) ? table[key] : hasOwn(MESSAGES[DEFAULT_LOCALE], key) ? MESSAGES[DEFAULT_LOCALE][key] : key;
  return params === undefined ? template : fillPlaceholders(template, params);
}
