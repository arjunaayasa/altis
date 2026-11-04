import { t as sharedT, type Locale, type MessageKey } from '@altis/shared';
import { ADMIN_EN } from '../../../apps/admin/src/i18n/en.js';
import { ADMIN_ID, type AdminKey } from '../../../apps/admin/src/i18n/id.js';

// The words the specs look for, taken from the catalogues the admin SPA renders (apps/admin/src/i18n, and
// @altis/shared for the shared families: errors, roles, OPAC), the way the SPA's own `translate` takes them. The specs
// find buttons, fields and messages by what a user reads, in either language, and a change of wording does not break
// them.

export type TextKey = AdminKey | MessageKey;

const ADMIN: Readonly<Record<Locale, Readonly<Record<AdminKey, string>>>> = Object.freeze({ id: ADMIN_ID, en: ADMIN_EN });

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** The text of `key` in `locale`, its `{name}` placeholders filled from `params`. */
export function tr(locale: Locale, key: TextKey, params?: Readonly<Record<string, string | number>>): string {
  const table = ADMIN[locale];
  if (!hasOwn(table, key)) return sharedT(locale, key as MessageKey, params);
  const template = table[key as AdminKey];
  if (params === undefined) return template;
  return template.replace(PLACEHOLDER, (whole: string, name: string) => (hasOwn(params, name) ? String(params[name]) : whole));
}

/** A pattern that matches exactly `text` (surrounding white space aside): for names that other names contain. */
export function exactText(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
}
