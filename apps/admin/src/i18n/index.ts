import { DEFAULT_LOCALE, t as sharedT, type Locale, type MessageKey } from '@altis/shared';
import { createContext, createElement, useCallback, useContext, type ReactNode } from 'react';
import { ADMIN_EN } from './en';
import { ADMIN_ID, type AdminKey } from './id';

/**
 * The admin SPA's i18n (decision D29): its own strings (`ADMIN_MESSAGES`, Indonesian first, English complete) and,
 * through the same `useT()`, the shared catalogs of @altis/shared (`error.<CODE>`, `perm.*`, `audit.*`, `banner.*`,
 * ...). The language is the signed-in user's, else the library's (`me.user.locale ?? me.library.locale`), set by the
 * shell through {@link I18nProvider}.
 */
export type { AdminKey } from './id';

export const ADMIN_MESSAGES: Readonly<Record<Locale, Readonly<Record<AdminKey, string>>>> = Object.freeze({
  id: Object.freeze(ADMIN_ID),
  en: Object.freeze(ADMIN_EN),
});

/** Every key `useT()` translates: the SPA's own, or a shared one. */
export type TKey = AdminKey | MessageKey;

export type Translate = (key: TKey, params?: Readonly<Record<string, string | number>>) => string;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/**
 * The text of `key` in `locale`. Admin keys are filled in one pass like the shared `t()` (a value that looks like a
 * placeholder is not expanded again; a placeholder without a value stays as written); any other key goes to the shared
 * `t()`, which answers with the key itself when it does not know it.
 */
export function translate(locale: Locale, key: TKey, params?: Readonly<Record<string, string | number>>): string {
  const table = hasOwn(ADMIN_MESSAGES, locale) ? ADMIN_MESSAGES[locale] : ADMIN_MESSAGES[DEFAULT_LOCALE];
  if (!hasOwn(table, key)) return sharedT(locale, key as MessageKey, params);
  const template = table[key as AdminKey];
  if (params === undefined) return template;
  return template.replace(PLACEHOLDER, (whole: string, name: string) => {
    if (!hasOwn(params, name)) return whole;
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** Sets the language of everything below it. */
export function I18nProvider({ locale, children }: { locale: Locale; children?: ReactNode }) {
  return createElement(LocaleContext.Provider, { value: locale }, children);
}

/** The current language (Indonesian outside any provider). */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** The translate function of the current language. */
export function useT(): Translate {
  const locale = useLocale();
  return useCallback<Translate>((key, params) => translate(locale, key, params), [locale]);
}
